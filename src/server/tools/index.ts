import { registerDocumentTools, registerHistoryTools } from "./document.js";
import { registerEditTools, registerSelectionTools } from "./edit.js";
import { registerExportTools } from "./export.js";
import { registerBlockInfoTool, registerInstanceTools } from "./instance.js";
import { registerLibraryTools } from "./library.js";
import { registerPaletteTools } from "./palette.js";
import { registerPerceptionTools } from "./perception.js";
import { registerPluginTools } from "./plugins.js";
import { registerTransformTools } from "./transform.js";
import { registerBrushTools } from "./brush.js";
import { registerQueryTools } from "./query.js";
import { registerAnchorTools } from "./anchor.js";
import { registerScriptTools } from "./script.js";
import { registerScopeTools } from "./scope.js";
import type { ToolDeps } from "./shared.js";

/**
 * Every tool group, in the order tools are listed to the client. A new feature area adds its own
 * module here (e.g. tools/library.ts, tools/scope.ts) instead of editing another group's module,
 * so parallel work rarely touches the same file.
 */
export const TOOL_GROUPS: readonly ((deps: ToolDeps) => void)[] = [
  registerInstanceTools,
  registerPaletteTools,
  registerBlockInfoTool,
  registerDocumentTools,
  registerSelectionTools,
  registerEditTools,
  registerTransformTools,
  registerBrushTools,
  registerAnchorTools,
  registerScriptTools,
  registerHistoryTools,
  registerExportTools,
  registerPerceptionTools,
  registerLibraryTools,
  registerPluginTools,
  registerQueryTools,
  registerScopeTools,
];
