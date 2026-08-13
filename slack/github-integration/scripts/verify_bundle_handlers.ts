import { pathToFileURL } from "node:url";
import {
  BUNDLE_HANDLER_PROOF,
  verifyBundleHandlerNamespaces,
} from "./verify_build.ts";

const namespaces = await Promise.all(
  Deno.args.map((path) => import(pathToFileURL(path).href)),
);
verifyBundleHandlerNamespaces(namespaces);
console.log(BUNDLE_HANDLER_PROOF);
