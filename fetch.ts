#!/usr/bin/env node
import { format } from 'util';
import { spawnChrome } from "chrome-debugging-client";
import type { Protocol } from "devtools-protocol";

function log(...args: any[]): void {
  process.stderr.write(format(...args) + '\n');
}

// 0-based
function getRowPos(str: string, row: number): number {
  if (row < 0) return -1;
  let pos = 0;
  for (let i = 0; i < row; i++) {
    pos = str.indexOf('\n', pos);
    if (pos === -1) return -1;
    pos += 1;
  }
  return pos;
}

async function getDeepSeekPlatformLocales(): Promise<any> {
  const platform_url = process.env.DEEPSEEK_PLATFORM_URL || "https://platform.deepseek.com/"; // may need proxy when accessing
  const platform_hostname = (new URL(platform_url)).hostname;
  const allowed_hosts = [platform_hostname, "fe-static.deepseek.com"];

  log("spawn browser");
  const chrome = spawnChrome({
    headless: true,
    additionalArguments: [
      "--host-resolver-rules="+["MAP * ~NOTFOUND", ...allowed_hosts.map(h => `EXCLUDE ${h}`)].join(", "),
      "--no-proxy-server",
    ],
  });

  try {
    log("connect to browser");
    const rootConnection = chrome.connection;
    const { targetId } = await rootConnection.send("Target.createTarget", {url: ""});
    const sessionConnection = await rootConnection.attachToTarget(targetId);

    // enable CDP domains
    await sessionConnection.send("Debugger.enable");
    await sessionConnection.send("Page.enable");
    await sessionConnection.send("Runtime.enable");

    async function getArrayElement(objectId: string, index: number, returnByValue=false): Promise<Protocol.Runtime.RemoteObject> {
      return (await sessionConnection.send("Runtime.callFunctionOn", {
        functionDeclaration: "function (i) { return this[i]; }",
        objectId,
        arguments: [{value: index}],
        returnByValue: returnByValue,
      })).result;
    }

    async function getProperties(objectId: string): Promise<Protocol.Runtime.GetPropertiesResponse> {
      return await sessionConnection.send("Runtime.getProperties", {
        objectId,
        ownProperties: true,
      });
    }

    log("load page");
    await Promise.all([
      sessionConnection.until("Page.loadEventFired"),
      sessionConnection.send("Page.navigate", {url: platform_url}),
    ]);

    log("push a dummy chunk to retrieve __webpack_require__");
    // throw ensures zero side-effect
    const __webpack_require__ = (await sessionConnection.send("Runtime.evaluate", {
      returnByValue: false,
      awaitPromise: true,
      expression: `new Promise(resolve=>{
  try {
    window.rspackChunk_deepseek_platform.push([
      ["dummy-chunk"],
      {},
      __webpack_require__ => {
        resolve(__webpack_require__);
        throw undefined;
      },
    ]);
  } finally {
  }
})`,
    })).result!.objectId!;
    log(`__webpack_require__: ${__webpack_require__}`);

    const functionInternalProperties = (await getProperties(__webpack_require__)).internalProperties!;

    log("find minified variable name for __webpack_module_cache__");
    const functionLocation: Protocol.Debugger.Location = functionInternalProperties.find(p => p.name === '[[FunctionLocation]]')!.value!.value;
    const scriptSource = (await sessionConnection.send("Debugger.getScriptSource", {scriptId: functionLocation.scriptId})).scriptSource;
    const functionPos = getRowPos(scriptSource, functionLocation.lineNumber) + functionLocation.columnNumber!;
    const variableName = scriptSource.slice(functionPos-32, functionPos).match(/,([A-Za-z]+)=\{\};function [A-Za-z]+$/)![1];
    log(`__webpack_module_cache__ minified variable name: ${variableName}`);

    log("retrieve __webpack_module_cache__ from closure");
    const functionScopes = functionInternalProperties.find(p => p.name === '[[Scopes]]')?.value?.objectId!;
    const functionScope = (await getArrayElement(functionScopes, 0))?.objectId!;
    const __webpack_module_cache__ = (await getProperties(functionScope)).result.find(p => p.name === variableName)?.value?.objectId;
    log(`__webpack_module_cache__: ${__webpack_module_cache__}`);

    log("enumerate __webpack_module_cache__ to collect locales");
    const locales = (await sessionConnection.send("Runtime.callFunctionOn", {
      objectId: __webpack_module_cache__,
      returnByValue: true, // functions will be replaced with {}
      functionDeclaration: `function () {
  const result = {en_US:{}, zh_CN: {}};
  for (const [module_id, module] of Object.entries(this)) {
    const exports = module?.exports;
    if (exports && exports.__esModule === true &&
      Object.keys(exports).length === 2 && Object.hasOwn(exports, "default")
    ) {
      const locale = Object.keys(exports).find(k => k !== "default");
      if (locale !== "en_US" && locale !== "zh_CN") continue;
      result[locale][module_id] = exports.default;
    }
  }
  return result;
}`,
    })).result?.value;
    await chrome.close();
    return locales;
  } finally {
    await chrome.dispose();
  }
}

function findNotifications(locales: Record<string, Record<string, Record<string, string | {}>>>): Record<string, Record<string, string>> {
  const notifications: Record<string, Record<string, string>> = {};
  for (const [localeName, locale] of Object.entries(locales)) {
    for (const [module_id, localeEntries] of Object.entries(locale)) {
      for (const [localeKey, localeValue] of Object.entries(localeEntries)) {
        if (/^[_0-9A-Za-z]+Notification\d*$/.test(localeKey) && typeof localeValue === 'string') {
          (notifications[localeKey] ??= {})[localeName] = localeValue;
        }
      }
    }
  }
  return notifications
}

async function main(): Promise<void> {
  const locales = await getDeepSeekPlatformLocales();
  log("post processing locales");

  const notifications = findNotifications(locales);
  console.log(JSON.stringify(notifications, null, 2));
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
