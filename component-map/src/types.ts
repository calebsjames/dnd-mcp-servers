// ── Scan Results ──

export interface TemplateProp {
  name: string;
  isDynamic: boolean; // :prop vs prop
  value?: string; // the expression/value
}

export interface VueImport {
  name: string;
  path: string;
  isVue: boolean;
  line: number; // actual file line number (1-based)
}

export interface TemplateUsage {
  name: string;
  lines: number[];
  props: TemplateProp[];
}

export interface TabDefinition {
  id: string;
  label: string;
  component?: string;
}

export interface DynamicComponentRef {
  name: string; // the component name referenced
  context: string; // e.g. "tab-map-value", "component-is", "defineAsyncComponent"
}

export interface ScanResult {
  filePath: string;
  componentName: string;
  imports: VueImport[];
  templateUsages: TemplateUsage[];
  emits: string[];
  tabs: TabDefinition[];
  scriptStartLine: number; // line where <script> starts (for true line numbers)
  dynamicComponents: DynamicComponentRef[];
}

// ── Component Graph ──

export interface ComponentUsage {
  file: string;
  importLine?: number;
  templateLines: number[];
  props?: TemplateProp[];
}

export interface ComponentEntry {
  name: string;
  definedIn: string;
  usedIn: ComponentUsage[];
  usageCount: number;
  emits: string[];
  tabs: TabDefinition[];
  variants?: string[]; // other file paths with the same component name
}

// ── Navigation Data (from navigation-data.json) ──

export interface RouteEntry {
  path: string;
  name?: string;
  component: string;
  file: string;
  params?: { name: string; type: string }[];
}

export interface SidebarViewEntry {
  group: string | null;
  label: string;
  viewKey: string;
  url: string;
  component: string;
  file: string;
  permission?: string;
  modals?: string[];
}

export interface ModalEntry {
  file: string;
  openedFrom: string[];
  trigger: string;
  tabs: TabDefinition[];
}

export interface NavigationStep {
  action: "navigate" | "wait_for" | "click" | "snapshot";
  url?: string;
  text?: string;
  description?: string;
  purpose?: string;
}

export interface NavigationPath {
  steps: NavigationStep[];
  componentChain?: string[];
  prerequisite?: string;
  permission?: string;
}

export interface NavigationData {
  _meta?: {
    version: string;
    lastScanned?: string;
  };
  routes: RouteEntry[];
  sidebarViews: SidebarViewEntry[];
  modals: Record<string, ModalEntry>;
  navigationPaths: Record<string, NavigationPath>;
}

// ── Tool Responses ──

export interface ComponentVariant {
  definedIn: string;
  usedIn: ComponentUsage[];
  usageCount: number;
  emits: string[];
  tabs: TabDefinition[];
}

export interface FindComponentResult {
  name: string;
  definedIn: string;
  usedIn: ComponentUsage[];
  usageCount: number;
  emits: string[];
  tabs: TabDefinition[];
  navigationPath?: NavigationPath;
  variants?: ComponentVariant[];
  allPaths?: NavigationPath[];
}

export interface SearchComponentResult {
  name: string;
  definedIn: string;
  usageCount: number;
  usedIn: string[];
  emits: string[];
  tabs: TabDefinition[];
}

export interface ScreenComponentsResult {
  screen: string;
  url: string;
  topComponent: string;
  file: string;
  children: { name: string; file: string }[];
  modals: {
    name: string;
    file: string;
    trigger: string;
    tabs: TabDefinition[];
  }[];
}
