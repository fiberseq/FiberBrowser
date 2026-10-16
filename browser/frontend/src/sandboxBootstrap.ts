// Served under a URL prefix (Open OnDemand, a lab proxy): every root-relative
// request gets the prefix, and a lab server's CSRF header is sent. Installed
// first, so the sandbox layer below wraps it.
import { installRootPath } from './utils/rootPath';
// A tour tab (`?sandbox=<id>`) must name its sandbox on every request and keep
// off the user's storage before any other module runs (stores read
// localStorage at import), so main.tsx imports this first.
import { installSandbox } from './utils/sandbox';
// A --public server's page: rate-limited reads wait and retry.
import { installPublicRetry } from './utils/publicRetry';

installRootPath();
installSandbox();
installPublicRetry();
