import { readFileSync } from "fs";
import { glob } from "glob";
import { basename, relative } from "path";
import type { ScanResult, VueImport, TemplateUsage, TemplateProp, TabDefinition, DynamicComponentRef, RouteEntry, SidebarViewEntry } from "./types.js";

// ── Section Extraction ──

function extractTemplate(content: string): { body: string; startLine: number } {
  const match = content.match(/<template>([\s\S]*?)<\/template>/);
  if (!match) return { body: "", startLine: 0 };

  const beforeTemplate = content.slice(0, match.index!);
  const startLine = beforeTemplate.split("\n").length;
  return { body: match[1], startLine };
}

function extractScript(content: string): { body: string; startLine: number } {
  const match = content.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return { body: "", startLine: 0 };

  const beforeScript = content.slice(0, match.index!);
  const startLine = beforeScript.split("\n").length;
  return { body: match[1], startLine };
}

// ── Import Extraction (with true line numbers) ──

function extractImports(script: string, scriptStartLine: number): VueImport[] {
  const imports: VueImport[] = [];
  const lines = script.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const defaultMatch = line.match(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (defaultMatch) {
      imports.push({
        name: defaultMatch[1],
        path: defaultMatch[2],
        isVue: defaultMatch[2].endsWith(".vue"),
        line: scriptStartLine + i,
      });
      continue;
    }

    const destructuredMatch = line.match(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+\.vue)['"]/);
    if (destructuredMatch) {
      const names = destructuredMatch[1].split(",").map((n) => n.trim().split(" as ").pop()!.trim());
      const path = destructuredMatch[2];
      for (const name of names) {
        if (name) {
          imports.push({ name, path, isVue: true, line: scriptStartLine + i });
        }
      }
    }
  }

  return imports;
}

// ── Template Usage Detection (with props) ──

function extractTemplateUsages(template: string, templateStartLine: number): TemplateUsage[] {
  const usages = new Map<string, { lines: number[]; propsMap: Map<string, TemplateProp> }>();
  const lines = template.split("\n");

  let tagBuffer = "";
  let tagStartLine = 0;
  let inTag = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fileLine = templateStartLine + i;

    if (inTag) {
      tagBuffer += " " + line;
      if (line.includes(">")) {
        inTag = false;
        processTag(tagBuffer, tagStartLine, usages);
      }
      continue;
    }

    const pascalMatches = line.matchAll(/<([A-Z][a-zA-Z0-9]+)/g);
    for (const m of pascalMatches) {
      const name = m[1];
      if (!usages.has(name)) usages.set(name, { lines: [], propsMap: new Map() });
      usages.get(name)!.lines.push(fileLine);

      const afterTag = line.slice(m.index! + m[0].length);
      if (afterTag.includes(">") || afterTag.includes("/>")) {
        const fullTag = line.slice(m.index!);
        extractPropsFromTag(fullTag, usages.get(name)!.propsMap);
      } else {
        tagBuffer = line.slice(m.index!);
        tagStartLine = fileLine;
        inTag = true;
      }
    }

    const kebabMatches = line.matchAll(/<([a-z]+-[a-z][a-z0-9-]*)/g);
    for (const m of kebabMatches) {
      const kebab = m[1];
      if (["base-modal", "router-view", "router-link", "keep-alive", "transition-group"].includes(kebab)) continue;
      const pascal = kebab
        .split("-")
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join("");
      if (!usages.has(pascal)) usages.set(pascal, { lines: [], propsMap: new Map() });
      usages.get(pascal)!.lines.push(fileLine);

      const afterTag = line.slice(m.index! + m[0].length);
      if (afterTag.includes(">") || afterTag.includes("/>")) {
        const fullTag = line.slice(m.index!);
        extractPropsFromTag(fullTag, usages.get(pascal)!.propsMap);
      } else {
        tagBuffer = line.slice(m.index!);
        tagStartLine = fileLine;
        inTag = true;
      }
    }
  }

  return Array.from(usages.entries()).map(([name, data]) => ({
    name,
    lines: data.lines,
    props: Array.from(data.propsMap.values()),
  }));
}

function processTag(tagContent: string, _startLine: number, usages: Map<string, { lines: number[]; propsMap: Map<string, TemplateProp> }>): void {
  const nameMatch = tagContent.match(/<([A-Z][a-zA-Z0-9]+)/);
  if (!nameMatch) return;
  const name = nameMatch[1];
  const entry = usages.get(name);
  if (entry) {
    extractPropsFromTag(tagContent, entry.propsMap);
  }
}

function extractPropsFromTag(tagContent: string, propsMap: Map<string, TemplateProp>): void {
  const dynamicPropRegex = /(?::|v-bind:)([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g;
  let match;
  while ((match = dynamicPropRegex.exec(tagContent)) !== null) {
    const propName = match[1];
    if (propName.startsWith("on") || ["if", "for", "show", "else", "else-if", "slot", "html", "text", "key", "ref", "class", "style", "is"].includes(propName)) continue;
    propsMap.set(propName, { name: propName, isDynamic: true, value: match[2] });
  }

  const staticPropRegex = /\s([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g;
  while ((match = staticPropRegex.exec(tagContent)) !== null) {
    const propName = match[1];
    if (propsMap.has(propName)) continue;
    if (propName.startsWith("v-") || propName.startsWith("@") || propName.startsWith(":")) continue;
    if (["class", "style", "id", "key", "ref", "slot", "is"].includes(propName)) continue;
    if (tagContent.indexOf(propName) === 1) continue;
    propsMap.set(propName, { name: propName, isDynamic: false, value: match[2] });
  }

  const booleanPropRegex = /\s([a-z][a-zA-Z0-9-]*)\s*(?=\/?>|\s[a-zA-Z:])/g;
  while ((match = booleanPropRegex.exec(tagContent)) !== null) {
    const propName = match[1];
    if (propsMap.has(propName)) continue;
    if (propName.startsWith("v-") || ["class", "style", "id", "key", "ref", "slot"].includes(propName)) continue;
    if (/^[a-z][a-zA-Z]*$/.test(propName) && !["disabled", "hidden", "readonly", "required", "checked", "selected", "multiple", "autofocus", "autoplay", "controls", "loop", "muted", "open", "defer", "async", "novalidate"].includes(propName)) {
      continue;
    }
    if (propName.includes("-")) {
      propsMap.set(propName, { name: propName, isDynamic: false });
    }
  }
}

// ── Emit Extraction ──

function extractEmits(script: string): string[] {
  const emits: string[] = [];

  const optionsMatch = script.match(/emits:\s*\[([^\]]+)\]/);
  if (optionsMatch) {
    const items = optionsMatch[1].matchAll(/['"]([^'"]+)['"]/g);
    for (const m of items) {
      emits.push(m[1]);
    }
  }

  const defineMatch = script.match(/defineEmits\s*\(\s*\[([^\]]+)\]/);
  if (defineMatch) {
    const items = defineMatch[1].matchAll(/['"]([^'"]+)['"]/g);
    for (const m of items) {
      emits.push(m[1]);
    }
  }

  return emits;
}

// ── Tab Definition Extraction ──

function extractTabs(script: string): TabDefinition[] {
  const tabs: TabDefinition[] = [];

  const tabArrayRegex = /(?:const\s+tabs|tabs)\s*(?:=|:)\s*(?:computed\s*\(\s*\(\)\s*=>\s*)?\[([^\]]*(?:\{[^}]*\}[^]]*?))\]/gs;
  let arrayMatch;

  while ((arrayMatch = tabArrayRegex.exec(script)) !== null) {
    const arrayContent = arrayMatch[1];
    const objectRegex = /\{\s*id:\s*['"]([^'"]+)['"]\s*,\s*label:\s*['"]([^'"]+)['"]/g;
    let objMatch;
    while ((objMatch = objectRegex.exec(arrayContent)) !== null) {
      tabs.push({
        id: objMatch[1],
        label: objMatch[2],
      });
    }
  }

  return tabs;
}

// ── Dynamic Component Detection ──

function extractDynamicComponents(script: string, imports: VueImport[]): DynamicComponentRef[] {
  const refs: DynamicComponentRef[] = [];
  const importedNames = new Set(imports.filter((i) => i.isVue).map((i) => i.name));

  const objectValueRegex = /(?:['"]?\w+['"]?\s*:\s*)(\b[A-Z][a-zA-Z0-9]+\b)/g;
  let match;
  while ((match = objectValueRegex.exec(script)) !== null) {
    const name = match[1];
    if (importedNames.has(name)) {
      refs.push({ name, context: "object-map-value" });
    }
  }

  const asyncRegex = /defineAsyncComponent\s*\(\s*\(\)\s*=>\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g;
  while ((match = asyncRegex.exec(script)) !== null) {
    const path = match[1];
    const name = basename(path, ".vue");
    const pascal = name.replace(/(^|[-_])(\w)/g, (_, __, c) => c.toUpperCase());
    refs.push({ name: pascal, context: "defineAsyncComponent" });
  }

  const arrayRefRegex = /\[\s*([A-Z][a-zA-Z0-9]+(?:\s*,\s*[A-Z][a-zA-Z0-9]+)*)\s*\]/g;
  while ((match = arrayRefRegex.exec(script)) !== null) {
    const names = match[1].split(",").map((n) => n.trim());
    for (const name of names) {
      if (importedNames.has(name) && !refs.some((r) => r.name === name)) {
        refs.push({ name, context: "array-ref" });
      }
    }
  }

  return refs;
}

// ── Component Name Derivation ──

function deriveComponentName(filePath: string, script: string): string {
  const nameMatch = script.match(/name:\s*['"](\w+)['"]/);
  if (nameMatch) return nameMatch[1];

  const defineMatch = script.match(/defineComponent\s*\(\s*\{\s*name:\s*['"](\w+)['"]/);
  if (defineMatch) return defineMatch[1];

  return basename(filePath, ".vue");
}

// ── Single File Scanner ──

export function scanVueFile(filePath: string, srcDir: string): ScanResult {
  const content = readFileSync(filePath, "utf-8");
  const template = extractTemplate(content);
  const script = extractScript(content);

  const imports = extractImports(script.body, script.startLine);
  const dynamicComponents = extractDynamicComponents(script.body, imports);

  return {
    filePath: relative(srcDir, filePath),
    componentName: deriveComponentName(filePath, script.body),
    imports,
    templateUsages: extractTemplateUsages(template.body, template.startLine),
    emits: extractEmits(script.body),
    tabs: extractTabs(script.body),
    scriptStartLine: script.startLine,
    dynamicComponents,
  };
}

// ── Batch Scanner ──

export async function scanAllVueFiles(srcDir: string): Promise<ScanResult[]> {
  const files = await glob(`${srcDir}/**/*.vue`, {
    ignore: ["**/node_modules/**", "**/dist/**"],
  });

  return files.map((f) => scanVueFile(f, srcDir));
}

// ── Router Parser ──

export function parseRouterFile(routerPath: string): RouteEntry[] {
  const routes: RouteEntry[] = [];

  try {
    const content = readFileSync(routerPath, "utf-8");

    const routeRegex = /\{\s*path:\s*['"]([^'"]+)['"]\s*,\s*name:\s*['"](\w+)['"](?:[\s\S]*?component:\s*(?:(\w+)|(?:\(\)\s*=>\s*import\(['"]@\/views\/(\w+)\.vue['"]\))))/g;

    let match;
    while ((match = routeRegex.exec(content)) !== null) {
      const path = match[1];
      const name = match[2];
      const component = match[3] || match[4];

      let file = "";
      if (match[3]) {
        const importMatch = content.match(new RegExp(`import\\s+${match[3]}\\s+from\\s+['"]@\\/([^'"]+)['"]`));
        if (importMatch) {
          file = "src/" + importMatch[1];
        } else {
          const importMatch2 = content.match(new RegExp(`import\\s+${match[3]}\\s+from\\s+['"]([^'"]+)['"]`));
          if (importMatch2) {
            file = importMatch2[1].replace("@/", "src/");
          }
        }
      } else if (match[4]) {
        file = `src/views/${match[4]}.vue`;
      }

      const params: { name: string; type: string }[] = [];
      const paramMatches = path.matchAll(/:(\w+)/g);
      for (const pm of paramMatches) {
        params.push({ name: pm[1], type: "string" });
      }

      routes.push({ path, name, component, file, params: params.length > 0 ? params : undefined });
    }
  } catch {
    console.error(`Failed to parse router file: ${routerPath}`);
  }

  return routes;
}

// ── Navigation File Parser ──
// Parses the top-level navigation component (e.g., NavMenu.vue or AppLayout.vue)
// that maps view keys to components. Adapt this to match dnd-ui's nav structure.

export function parseSidebarFile(navPath: string, homePagePath: string): SidebarViewEntry[] {
  const entries: SidebarViewEntry[] = [];

  try {
    const navContent = readFileSync(navPath, "utf-8");
    const homeContent = readFileSync(homePagePath, "utf-8");

    // Build a map of viewKey → component from home/app component
    const viewMap = new Map<string, string>();
    const viewRegex = /<(\w+)\s+v-if="currentView\s*===\s*'([^']+)'"/g;
    let viewMatch;
    while ((viewMatch = viewRegex.exec(homeContent)) !== null) {
      viewMap.set(viewMatch[2], viewMatch[1]);
    }

    // Build import map: component name → file
    const importMap = new Map<string, string>();
    const importRegex = /import\s+(\w+)\s+from\s+['"]@\/([^'"]+)['"]/g;
    let importMatch;
    while ((importMatch = importRegex.exec(homeContent)) !== null) {
      importMap.set(importMatch[1], "src/" + importMatch[2]);
    }

    // Parse nav items — adapt pattern to match dnd-ui's nav component structure
    const navItemRegex = /<NavItem[\s\S]*?label="([^"]+)"[\s\S]*?(?:\/>|<\/NavItem>)/g;
    let navMatch;

    while ((navMatch = navItemRegex.exec(navContent)) !== null) {
      const itemBlock = navMatch[0];
      const label = navMatch[1];

      const permMatch = itemBlock.match(/v-if="checkPermission\(Permission\.(\w+)\)"/);
      const permission = permMatch ? permMatch[1] : undefined;

      const component = viewMap.get(label);
      const file = component ? importMap.get(component) : undefined;

      entries.push({
        group: null,
        label,
        viewKey: label,
        url: `/?view=${encodeURIComponent(label).replace(/%20/g, "+")}`,
        component: component || label,
        file: file || "",
        permission,
      });
    }
  } catch (e) {
    console.error(`Failed to parse nav/home: ${e}`);
  }

  return entries;
}

// ── Global Component Detection ──

export function parseGlobalComponents(mainTsPath: string): { name: string; file: string }[] {
  const globals: { name: string; file: string }[] = [];

  try {
    const content = readFileSync(mainTsPath, "utf-8");

    const regex = /app\.component\s*\(\s*['"](\w+)['"]\s*,\s*(\w+)\s*\)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      const importMatch = content.match(new RegExp(`import\\s+${match[2]}\\s+from\\s+['"]([^'"]+)['"]`));
      globals.push({
        name,
        file: importMatch ? importMatch[1].replace("@/", "src/") : "",
      });
    }
  } catch {
    // main.ts may not exist or have different patterns
  }

  return globals;
}
