/**
 * uPassa: A meta-framework for generating type-safe language frontends.
 *
 * Two layers:
 * - nanopass: tree rewriting with fusion
 * - ssa: graph optimization infrastructure
 */

export * as nanopass from "./nanopass/index.ts";
export * as ssa from "./ssa/index.ts";
