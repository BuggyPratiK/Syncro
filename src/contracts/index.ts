/**
 * Shared API contract: constants, identifier formats, roles, error codes,
 * request schemas, response shapes, the route table and data-operation
 * interfaces. The single import surface for the dashboard API and the web app.
 *
 * Changes here change the public API, so they must be made deliberately and
 * kept backward compatible with deployed clients.
 */

export * from "./constants";
export * from "./ids";
export * from "./roles";
export * from "./errors";
export * from "./schemas";
export * from "./dto";
export * from "./routes";
export type * from "./data-ops";
