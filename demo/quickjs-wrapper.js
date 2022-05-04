import ModuleLoader from "./quickjs-eval.js";

// Would like to strip this down to the minimum possible to define
// a function, call it, and get the return value back onto the web page:

export function QuickJSSandbox() {
  return ModuleLoader().then((module) => {
    return new Sandbox(window, module);
  });
}

export async function evalInSandbox(code, data) {
  let sandbox = await QuickJSSandbox();
  sandbox.create(data);
  sandbox.evalForTesting(code);
}

const PDFJSDev = {
  test() {
    return true;
  },
  eval() {
    return "";
  },
};
class SandboxSupportBase {
  /**
   * @param {DOMWindow} - win
   */
  constructor() {
    this.timeoutIds = new Map();

    // Will be assigned after the sandbox is initialized
    this.commFun = null;
  }

  destroy() {
    this.commFunc = null;
    this.timeoutIds.forEach(([_, id]) => clearTimeout(id));
    this.timeoutIds = null;
  }

  /**
   * @param {Object} val - Export a value in the sandbox.
   */
  exportValueToSandbox(val) {
    throw new Error("Not implemented");
  }

  /**
   * @param {Object} val - Import a value from the sandbox.
   */
  importValueFromSandbox(val) {
    throw new Error("Not implemented");
  }

  /**
   * @param {String} errorMessage - Create an error in the sandbox.
   */
  createErrorForSandbox(errorMessage) {
    throw new Error("Not implemented");
  }

  /**
   * @param {String} name - Name of the function to call in the sandbox
   * @param {Array<Object>} args - Arguments of the function.
   */
  callSandboxFunction(name, args) {
    try {
      args = this.exportValueToSandbox(args);
      this.commFun(name, args);
    } catch (e) {
      console.error(e);
    }
  }

  createSandboxExternals() {
    // All the functions in externals object are called
    // from the sandbox.
    const externals = {
      setTimeout: (callbackId, nMilliseconds) => {
        if (
          typeof callbackId !== "number" ||
          typeof nMilliseconds !== "number"
        ) {
          return;
        }
        const id = setTimeout(() => {
          this.timeoutIds.delete(callbackId);
          this.callSandboxFunction("timeoutCb", {
            callbackId,
            interval: false,
          });
        }, nMilliseconds);
        this.timeoutIds.set(callbackId, id);
      },
      clearTimeout: (id) => {
        clearTimeout(this.timeoutIds.get(id));
        this.timeoutIds.delete(id);
      },
      setInterval: (callbackId, nMilliseconds) => {
        if (
          typeof callbackId !== "number" ||
          typeof nMilliseconds !== "number"
        ) {
          return;
        }
        const id = setInterval(() => {
          this.callSandboxFunction("timeoutCb", {
            callbackId,
            interval: true,
          });
        }, nMilliseconds);
        this.timeoutIds.set(callbackId, id);
      },
      clearInterval: (id) => {
        clearInterval(this.timeoutIds.get(id));
        this.timeoutIds.delete(id);
      },
      alert: (cMsg) => {
        if (typeof cMsg !== "string") {
          return;
        }
        alert(cMsg);
      },
      confirm: (cMsg) => {
        if (typeof cMsg !== "string") {
          return false;
        }
        return confirm(cMsg);
      },
      prompt: (cQuestion, cDefault) => {
        if (typeof cQuestion !== "string" || typeof cDefault !== "string") {
          return null;
        }
        return prompt(cQuestion, cDefault);
      },
      parseURL: (cUrl) => {
        const url = new URL(cUrl);
        const props = [
          "hash",
          "host",
          "hostname",
          "href",
          "origin",
          "password",
          "pathname",
          "port",
          "protocol",
          "search",
          "searchParams",
          "username",
        ];

        return Object.fromEntries(
          props.map((name) => [name, url[name].toString()])
        );
      },
      send: (data) => {
        if (!data) {
          return;
        }
        const event = new CustomEvent("updatefromsandbox", {
          detail: this.importValueFromSandbox(data),
        });
        dispatchEvent(event);
      },
    };
    Object.setPrototypeOf(externals, null);

    return (name, args) => {
      try {
        const result = externals[name](...args);
        return this.exportValueToSandbox(result);
      } catch (error) {
        throw this.createErrorForSandbox(error?.toString() ?? "");
      }
    };
  }
}
class SandboxSupport extends SandboxSupportBase {
  exportValueToSandbox(val) {
    // The communication with the Quickjs sandbox is based on strings
    // So we use JSON.stringfy to serialize
    return JSON.stringify(val);
  }

  importValueFromSandbox(val) {
    return val;
  }

  createErrorForSandbox(errorMessage) {
    return new Error(errorMessage);
  }
}

class Sandbox {
  constructor(win, module) {
    this.support = new SandboxSupport(win, this);

    // The "external" functions created in pdf.sandbox.external.js
    // are finally used here:
    // https://github.com/mozilla/pdf.js.quickjs/blob/main/src/myjs.js
    // They're called from the sandbox only.
    module.externalCall = this.support.createSandboxExternals();

    this._module = module;

    // 0 to display error using console.error
    // else display error using window.alert
    this._alertOnError = 0;
  }

  create(data) {
    if (PDFJSDev.test("!PRODUCTION || TESTING")) {
      this._module.ccall("nukeSandbox", null, []);
    }
    const code = [PDFJSDev.eval("PDF_SCRIPTING_JS_SOURCE")];

    if (PDFJSDev.test("!PRODUCTION || TESTING")) {
      code.push(
        `globalThis.sendResultForTesting = callExternalFunction.bind(null, "send");`
      );
    } else {
      code.push("delete dump;");
    }

    let success = false;
    let buf = 0;
    try {
      const sandboxData = JSON.stringify(data);
      console.log(sandboxData);
      // "pdfjsScripting.initSandbox..." MUST be the last line to be evaluated
      // since the returned value is used for the communication.
      code.push(`
      function initSandbox(params) {
        dump(params);
      }`);
      code.push(`initSandbox({ data: ${sandboxData} })`);
      buf = this._module.stringToNewUTF8(code.join("\n"));

      success = !!this._module.ccall(
        "init",
        "number",
        ["number", "number"],
        [buf, this._alertOnError]
      );
    } catch (error) {
      console.error(error);
    } finally {
      if (buf) {
        this._module.ccall("free", "number", ["number"], [buf]);
      }
    }

    if (success) {
      this.support.commFun = this._module.cwrap("commFun", null, [
        "string",
        "string",
      ]);
    } else {
      this.nukeSandbox();
      throw new Error("Cannot start sandbox");
    }
  }

  dispatchEvent(event) {
    this.support?.callSandboxFunction("dispatchEvent", event);
  }

  dumpMemoryUse() {
    if (this._module) {
      this._module.ccall("dumpMemoryUse", null, []);
    }
  }

  nukeSandbox() {
    if (this._module !== null) {
      this.support.destroy();
      this.support = null;
      this._module.ccall("nukeSandbox", null, []);
      this._module = null;
    }
  }

  evalForTesting(code, key) {
    if (PDFJSDev.test("!PRODUCTION || TESTING")) {
      this._module.ccall(
        "evalInSandbox",
        null,
        ["string", "int"],
        [
          `
          try {
             sendResultForTesting([{ id: "${key}", result: ${code} }]);
          } catch (error) {
             sendResultForTesting([{ id: "${key}", result: error.message }]);
          }
          `,
          this._alertOnError,
        ]
      );
    } else {
      throw new Error("Not implemented: evalForTesting");
    }
  }
}
