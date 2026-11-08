/**
 * Handler registry — maps X-GitHub-Event header values to handler functions.
 */

export { handlePushEvent } from "./push.handler";
export { handlePullRequestEvent } from "./pull-request.handler";
