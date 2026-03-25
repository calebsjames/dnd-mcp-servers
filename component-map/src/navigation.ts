import { readFileSync, writeFileSync, existsSync } from "fs";
import type {
  NavigationData,
  NavigationPath,
  NavigationStep,
  SidebarViewEntry,
  ModalEntry,
  ScreenComponentsResult,
  RouteEntry,
} from "./types.js";
import { ComponentGraph } from "./graph.js";

const BASE_URL = "http://localhost:5173";

export class NavigationResolver {
  private data: NavigationData;
  private dataPath: string;

  constructor(navDataPath: string) {
    this.dataPath = navDataPath;
    this.data = this.loadData();
  }

  private loadData(): NavigationData {
    if (!existsSync(this.dataPath)) {
      return {
        _meta: { version: "1.0" },
        routes: [],
        sidebarViews: [],
        modals: {},
        navigationPaths: {},
      };
    }

    try {
      const raw = readFileSync(this.dataPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      console.error(`Failed to parse navigation data at ${this.dataPath}`);
      return {
        _meta: { version: "1.0" },
        routes: [],
        sidebarViews: [],
        modals: {},
        navigationPaths: {},
      };
    }
  }

  reload(): void {
    this.data = this.loadData();
  }

  getData(): NavigationData {
    return this.data;
  }

  /** Update navigation data from scanner results (merges, doesn't overwrite manual entries) */
  updateFromScanner(routes: RouteEntry[], sidebarViews: SidebarViewEntry[]): void {
    this.data.routes = routes;
    this.data.sidebarViews = sidebarViews;
    this.data._meta = {
      ...this.data._meta,
      version: "1.0",
      lastScanned: new Date().toISOString(),
    };
    this.save();
  }

  /** Auto-populate sidebarViews[].modals by cross-referencing graph children with known modals */
  autoPopulateModals(graph: ComponentGraph): void {
    const modalNames = new Set(Object.keys(this.data.modals));

    for (const view of this.data.sidebarViews) {
      if (!view.component) continue;

      const directChildren = graph.getChildrenOf(view.component);
      const viewModals: string[] = [];

      for (const childName of directChildren) {
        if (modalNames.has(childName)) {
          viewModals.push(childName);
        }
        const grandchildren = graph.getChildrenOf(childName);
        for (const gc of grandchildren) {
          if (modalNames.has(gc) && !viewModals.includes(gc)) {
            viewModals.push(gc);
          }
        }
      }

      for (const [modalName, modal] of Object.entries(this.data.modals)) {
        if (modal.openedFrom.includes(view.component) && !viewModals.includes(modalName)) {
          viewModals.push(modalName);
        }
      }

      if (viewModals.length > 0) {
        view.modals = viewModals;
      }
    }

    this.save();
  }

  /** Update a specific navigation entry (used by update_navigation_entry tool) */
  updateEntry(section: string, key: string, data: Record<string, unknown>): void {
    if (section === "modals") {
      this.data.modals[key] = {
        ...(this.data.modals[key] || { file: "", openedFrom: [], trigger: "", tabs: [] }),
        ...data,
      } as ModalEntry;
    } else if (section === "navigationPaths") {
      this.data.navigationPaths[key] = {
        ...(this.data.navigationPaths[key] || { steps: [] }),
        ...data,
      } as NavigationPath;
    }
    this.save();
  }

  private save(): void {
    writeFileSync(this.dataPath, JSON.stringify(this.data, null, 2) + "\n", "utf-8");
  }

  // ── Path Resolution ──

  /** Get navigation path for a target (component name, view name, or modal name) */
  resolveNavigationPath(target: string, graph: ComponentGraph): NavigationPath | null {
    // 1. Check pre-computed paths first
    if (this.data.navigationPaths[target]) {
      return this.data.navigationPaths[target];
    }

    // 2. Check if target is a modal
    if (this.data.modals[target]) {
      return this.buildModalPath(target);
    }

    // 3. Check if target is a sidebar view
    const sidebarView = this.data.sidebarViews.find(
      (v) => v.component === target || v.label === target || v.viewKey === target
    );
    if (sidebarView) {
      return this.buildSidebarPath(sidebarView);
    }

    // 4. Check if target is a route
    const route = this.data.routes.find(
      (r) => r.component === target || r.name === target
    );
    if (route) {
      return {
        steps: [
          { action: "navigate", url: `${BASE_URL}${route.path}` },
          { action: "snapshot", purpose: `Verify ${target} is rendered` },
        ],
      };
    }

    // 5. Check if target is a tab component inside a modal
    const tabPath = this.buildTabComponentPath(target);
    if (tabPath) return tabPath;

    // 6. Walk the component graph upward to find a reachable ancestor
    return this.buildGraphWalkPath(target, graph);
  }

  /** Resolve ALL navigation paths for a target (for multi-path responses) */
  resolveAllPaths(target: string, graph: ComponentGraph): NavigationPath[] {
    const paths: NavigationPath[] = [];

    for (const [modalName, modal] of Object.entries(this.data.modals)) {
      const tab = modal.tabs.find((t) => t.component === target);
      if (tab) {
        const modalPath = this.buildModalPath(modalName);
        if (modalPath) {
          modalPath.steps.push({
            action: "click",
            description: `Click '${tab.label}' tab`,
          });
          modalPath.steps.push({
            action: "snapshot",
            purpose: `Verify ${target} is visible in ${tab.label} tab`,
          });
          modalPath.componentChain = [...(modalPath.componentChain || []), target];
          paths.push(modalPath);
        }
      }
    }

    if (paths.length === 0) {
      const chains = graph.getAllParentChains(target);
      for (const chain of chains) {
        const rootName = chain[0];
        const rootView = this.data.sidebarViews.find((v) => v.component === rootName);
        if (rootView) {
          const path = this.buildChainPath(chain, rootView, graph);
          if (path) paths.push(path);
        }
      }
    }

    if (paths.length === 0) {
      const single = this.resolveNavigationPath(target, graph);
      if (single) paths.push(single);
    }

    return paths;
  }

  /** Build path to a tab component inside a modal */
  private buildTabComponentPath(target: string): NavigationPath | null {
    for (const [modalName, modal] of Object.entries(this.data.modals)) {
      const tab = modal.tabs.find((t) => t.component === target);
      if (!tab) continue;

      const modalPath = this.buildModalPath(modalName);
      if (!modalPath) continue;

      modalPath.steps.push({
        action: "click",
        description: `Click '${tab.label}' tab`,
      });
      modalPath.steps.push({
        action: "snapshot",
        purpose: `Verify ${target} is visible in ${tab.label} tab`,
      });
      modalPath.componentChain = [...(modalPath.componentChain || []), target];

      return modalPath;
    }
    return null;
  }

  /** Build path by walking the component graph upward */
  private buildGraphWalkPath(target: string, graph: ComponentGraph): NavigationPath | null {
    const chain = graph.getParentChain(target);
    if (chain.length <= 1) return null;

    const rootName = chain[0];

    const rootView = this.data.sidebarViews.find((v) => v.component === rootName);
    if (rootView) {
      return this.buildChainPath(chain, rootView, graph);
    }

    return null;
  }

  /** Build a navigation path from a component chain and root view */
  private buildChainPath(chain: string[], rootView: SidebarViewEntry, graph: ComponentGraph): NavigationPath {
    const target = chain[chain.length - 1];
    const path = this.buildSidebarPath(rootView);

    for (let i = 1; i < chain.length; i++) {
      const componentName = chain[i];

      if (this.data.modals[componentName]) {
        const modal = this.data.modals[componentName];
        path.steps.push({
          action: "click",
          description: modal.trigger || `Open ${componentName}`,
        });
        path.steps.push({
          action: "wait_for",
          text: modal.tabs.length > 0 ? modal.tabs[0].label : componentName.replace("Modal", ""),
        });

        if (i < chain.length - 1 || componentName !== target) {
          const nextInChain = chain[i + 1] || target;
          const tab = modal.tabs.find((t) => t.component === nextInChain);
          if (tab) {
            path.steps.push({
              action: "click",
              description: `Click '${tab.label}' tab`,
            });
            i++;
          }
        }
        continue;
      }

      if (i > 1) {
        const prevComponent = chain[i - 1];
        if (this.data.modals[prevComponent]) {
          const modal = this.data.modals[prevComponent];
          const tab = modal.tabs.find((t) => t.component === componentName);
          if (tab) {
            path.steps.push({
              action: "click",
              description: `Click '${tab.label}' tab`,
            });
          }
        }
      }
    }

    path.componentChain = chain;
    path.steps.push({
      action: "snapshot",
      purpose: `Verify ${target} is visible`,
    });

    return path;
  }

  private buildSidebarPath(view: SidebarViewEntry): NavigationPath {
    const steps: NavigationStep[] = [
      { action: "navigate", url: `${BASE_URL}${view.url}` },
      { action: "wait_for", text: view.label },
      { action: "snapshot", purpose: `Verify ${view.component} is rendered` },
    ];

    return {
      steps,
      permission: view.permission,
    };
  }

  private buildModalPath(modalName: string): NavigationPath {
    const modal = this.data.modals[modalName];
    if (!modal) return { steps: [] };

    const parentView = this.data.sidebarViews.find(
      (v) => v.modals?.includes(modalName)
    );

    const fallbackView = parentView || this.data.sidebarViews.find(
      (v) => modal.openedFrom.includes(v.component)
    );

    const steps: NavigationStep[] = [];

    if (fallbackView) {
      steps.push(
        { action: "navigate", url: `${BASE_URL}${fallbackView.url}` },
        { action: "wait_for", text: fallbackView.label }
      );
    }

    steps.push(
      { action: "click", description: modal.trigger || `Open ${modalName}` },
      { action: "wait_for", text: modal.tabs.length > 0 ? modal.tabs[0].label : modalName.replace("Modal", "") },
      { action: "snapshot", purpose: `Verify ${modalName} is open` }
    );

    return {
      steps,
      componentChain: fallbackView ? [fallbackView.component, modalName] : [modalName],
      permission: fallbackView?.permission,
    };
  }

  // ── Screen Components ──

  /** Get all components rendered on a screen, including modal contents */
  getScreenComponents(
    screenName: string,
    graph: ComponentGraph,
    includeModals: boolean = true
  ): ScreenComponentsResult | null {
    const view = this.data.sidebarViews.find(
      (v) => v.label === screenName || v.component === screenName || v.viewKey === screenName
    );

    if (!view) return null;

    const children = graph.getChildrenOf(view.component).map((name) => ({
      name,
      file: graph.get(name)?.definedIn || "",
    }));

    const modals: ScreenComponentsResult["modals"] = [];
    if (includeModals) {
      const modalNames = view.modals || [];

      for (const [modalName, modal] of Object.entries(this.data.modals)) {
        if (!modalNames.includes(modalName) && modal.openedFrom.includes(view.component)) {
          modalNames.push(modalName);
        }
      }

      for (const modalName of modalNames) {
        const modalData = this.data.modals[modalName];
        const modalEntry = graph.get(modalName);

        modals.push({
          name: modalName,
          file: modalData?.file || modalEntry?.definedIn || "",
          trigger: modalData?.trigger || "",
          tabs: modalData?.tabs || modalEntry?.tabs || [],
        });
      }
    }

    return {
      screen: view.label,
      url: view.url,
      topComponent: view.component,
      file: view.file,
      children,
      modals,
    };
  }
}
