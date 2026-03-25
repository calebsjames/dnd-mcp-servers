import type { ScanResult, ComponentEntry, ComponentUsage } from "./types.js";

export class ComponentGraph {
  // Primary storage: file path → entry
  private byFile = new Map<string, ComponentEntry>();
  // Name index: component name → file paths (handles collisions)
  private nameIndex = new Map<string, string[]>();
  // Reverse lookup: file path → component name
  private fileToComponent = new Map<string, string>();
  // Global components: name → file
  private globalComponents = new Map<string, string>();

  build(scanResults: ScanResult[]): void {
    this.byFile.clear();
    this.nameIndex.clear();
    this.fileToComponent.clear();

    // Phase 1: Register all component definitions
    for (const result of scanResults) {
      const entry: ComponentEntry = {
        name: result.componentName,
        definedIn: result.filePath,
        usedIn: [],
        usageCount: 0,
        emits: result.emits,
        tabs: result.tabs,
      };

      this.byFile.set(result.filePath, entry);
      this.fileToComponent.set(result.filePath, result.componentName);

      // Build name index (allows multiple files per name)
      const existing = this.nameIndex.get(result.componentName) || [];
      existing.push(result.filePath);
      this.nameIndex.set(result.componentName, existing);
    }

    // Phase 1.5: Mark name collisions with variants
    for (const [name, files] of this.nameIndex) {
      if (files.length > 1) {
        for (const file of files) {
          const entry = this.byFile.get(file)!;
          entry.variants = files.filter((f) => f !== file);
        }
      }
    }

    // Phase 2: Build usage edges from imports and template usage
    for (const result of scanResults) {
      // From imports: if file A imports component B.vue, that's a usage
      for (const imp of result.imports) {
        if (!imp.isVue) continue;

        // Resolve: try exact name match first, then check all entries
        const targetFiles = this.nameIndex.get(imp.name);
        if (!targetFiles || targetFiles.length === 0) continue;

        // Find template usage lines and props for this component
        const templateUsage = result.templateUsages.find((t) => t.name === imp.name);

        // Add usage to ALL entries with this name (handles collisions)
        for (const targetFile of targetFiles) {
          const targetEntry = this.byFile.get(targetFile)!;

          // Skip self-references
          if (targetFile === result.filePath) continue;

          const usage: ComponentUsage = {
            file: result.filePath,
            importLine: imp.line,
            templateLines: templateUsage ? templateUsage.lines : [],
            props: templateUsage?.props,
          };

          targetEntry.usedIn.push(usage);
          targetEntry.usageCount++;
        }
      }

      // From dynamic component references (object maps, defineAsyncComponent)
      for (const dynRef of result.dynamicComponents) {
        const targetFiles = this.nameIndex.get(dynRef.name);
        if (!targetFiles) continue;

        for (const targetFile of targetFiles) {
          const targetEntry = this.byFile.get(targetFile)!;
          if (targetFile === result.filePath) continue;

          // Check if already added via imports
          const alreadyAdded = targetEntry.usedIn.some((u) => u.file === result.filePath);
          if (alreadyAdded) continue;

          targetEntry.usedIn.push({
            file: result.filePath,
            templateLines: [],
          });
          targetEntry.usageCount++;
        }
      }

      // From template usages that don't have a matching import (global/auto-registered)
      for (const tu of result.templateUsages) {
        const targetFiles = this.nameIndex.get(tu.name);
        if (!targetFiles) continue;

        for (const targetFile of targetFiles) {
          const targetEntry = this.byFile.get(targetFile)!;
          if (targetFile === result.filePath) continue;

          // Check if already added via imports or dynamic refs
          const alreadyAdded = targetEntry.usedIn.some((u) => u.file === result.filePath);
          if (alreadyAdded) continue;

          targetEntry.usedIn.push({
            file: result.filePath,
            templateLines: tu.lines,
            props: tu.props,
          });
          targetEntry.usageCount++;
        }
      }
    }
  }

  setGlobalComponents(globals: { name: string; file: string }[]): void {
    this.globalComponents.clear();
    for (const g of globals) {
      this.globalComponents.set(g.name, g.file);
    }
  }

  // ── Queries ──

  /** Get a component by name. Returns the first match (or only match). */
  get(name: string): ComponentEntry | undefined {
    const files = this.nameIndex.get(name);
    if (!files || files.length === 0) return undefined;
    return this.byFile.get(files[0]);
  }

  /** Get a component by its file path. */
  getByFile(file: string): ComponentEntry | undefined {
    return this.byFile.get(file);
  }

  /** Get all entries for a component name (handles name collisions). */
  getAllByName(name: string): ComponentEntry[] {
    const files = this.nameIndex.get(name);
    if (!files) return [];
    return files.map((f) => this.byFile.get(f)!);
  }

  /** Check if a name has collisions (multiple files define it). */
  hasNameCollision(name: string): boolean {
    const files = this.nameIndex.get(name);
    return !!files && files.length > 1;
  }

  getAll(): ComponentEntry[] {
    return Array.from(this.byFile.values());
  }

  /** Find which components are used in a given file */
  getChildrenOf(componentName: string): string[] {
    // Get all files that define this component name
    const files = this.nameIndex.get(componentName);
    if (!files) return [];

    const children = new Set<string>();
    for (const file of files) {
      for (const [, comp] of this.byFile) {
        if (comp.usedIn.some((u) => u.file === file)) {
          children.add(comp.name);
        }
      }
    }
    return Array.from(children);
  }

  /** Walk reverse edges: from a component, find what uses it, up to a root. */
  getParentChain(componentName: string): string[] {
    const chain: string[] = [componentName];
    const visited = new Set<string>([componentName]);
    let current = componentName;

    while (true) {
      const entries = this.getAllByName(current);
      if (entries.length === 0) break;

      let foundParent = false;
      for (const entry of entries) {
        if (entry.usedIn.length === 0) continue;

        const parentFile = entry.usedIn[0].file;
        const parentName = this.fileToComponent.get(parentFile);

        if (!parentName || visited.has(parentName)) continue;

        chain.unshift(parentName);
        visited.add(parentName);
        current = parentName;
        foundParent = true;
        break;
      }

      if (!foundParent) break;
    }

    return chain;
  }

  /** Get ALL parent chains for a component (one per usage site). Used for multi-path nav. */
  getAllParentChains(componentName: string): string[][] {
    const entries = this.getAllByName(componentName);
    if (entries.length === 0) return [];

    const chains: string[][] = [];

    for (const entry of entries) {
      for (const usage of entry.usedIn) {
        const parentName = this.fileToComponent.get(usage.file);
        if (!parentName) continue;

        const chain = [componentName];
        const visited = new Set<string>([componentName]);
        let current = parentName;

        while (current) {
          if (visited.has(current)) break;
          chain.unshift(current);
          visited.add(current);

          const parentEntries = this.getAllByName(current);
          let nextParent: string | null = null;
          for (const pe of parentEntries) {
            if (pe.usedIn.length > 0) {
              const pf = pe.usedIn[0].file;
              const pn = this.fileToComponent.get(pf);
              if (pn && !visited.has(pn)) {
                nextParent = pn;
                break;
              }
            }
          }
          current = nextParent!;
        }

        const chainKey = chain.join(" → ");
        if (!chains.some((c) => c.join(" → ") === chainKey)) {
          chains.push(chain);
        }
      }
    }

    return chains;
  }

  /** Find components that are defined but never used */
  getOrphans(): ComponentEntry[] {
    return Array.from(this.byFile.values()).filter(
      (c) => c.usageCount === 0 && !this.globalComponents.has(c.name)
    );
  }

  /** Search components by name (case-insensitive substring match, scored) */
  search(query: string, limit: number = 10): ComponentEntry[] {
    const q = query.toLowerCase();
    const scored: { entry: ComponentEntry; score: number }[] = [];
    const seen = new Set<string>();

    for (const entry of this.byFile.values()) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);

      const name = entry.name.toLowerCase();
      const file = entry.definedIn.toLowerCase();

      let score = 0;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 90;
      else if (name.includes(q)) score = 70;
      else if (file.includes(q)) score = 50;
      else continue;

      scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
    return scored.slice(0, limit).map((s) => s.entry);
  }

  /** Get summary stats */
  getStats(): { totalComponents: number; totalUsages: number; orphanCount: number; nameCollisions: number } {
    let totalUsages = 0;
    let orphanCount = 0;
    for (const c of this.byFile.values()) {
      totalUsages += c.usageCount;
      if (c.usageCount === 0 && !this.globalComponents.has(c.name)) orphanCount++;
    }

    let nameCollisions = 0;
    for (const files of this.nameIndex.values()) {
      if (files.length > 1) nameCollisions++;
    }

    return {
      totalComponents: this.byFile.size,
      totalUsages,
      orphanCount,
      nameCollisions,
    };
  }
}
