/**
 * Generators (docs/design/05-operations.md, L3): parametric builders that register components.
 * Conveniences, not a style system: parameters stay open, and L1/L2 ops are always available.
 */
export { roof, type RoofOptions, type RoofStyle } from "./roof.js";
export { arch, column, staircase, type ArchOptions, type ArchStyle, type ColumnOptions, type StaircaseOptions } from "./elements.js";
export { door, window, type DoorOptions, type WindowOptions } from "./openings.js";
export { tower, towerFootprint, wallRun, type TowerOptions, type WallRunOptions } from "./structures.js";
export { shapeSet, type GenOptions, type GenResult } from "./shared.js";
