importScripts("https://cdn.jsdelivr.net/npm/comlink");
// self.languagePluginUrl = "https://cdn.jsdelivr.net/pyodide/dev/full/pyodide.js";
self.languagePluginUrl = "./pyodide-build/pyodide.js";
importScripts(self.languagePluginUrl);
let fetchPythonCode = fetch("code.py");

function sleep(t){
    return new Promise(resolve => setTimeout(resolve, t));
}

function promiseHandles(){
    let result;
    let promise = new Promise((resolve, reject) => {
        result = {resolve, reject};
    });
    result.promise = promise;
    return result;
}


// Comlink proxy and PyProxy don't get along as of yet so need a wrapper
function complete(value){
    let proxy = pycomplete(value);
    let result = proxy.toJs();
    proxy.destroy();
    return result;
}

class InnerExecution {
    constructor(code){
        this._code = code;
        this._interrupt_buffer = new Int32Array(new SharedArrayBuffer(4));
        this._validate_syntax = promiseHandles();
        this._result = promiseHandles();
        this._result.promise.finally(() => {
            for(let proxy of this.proxies){
                proxy[Comlink.releaseProxy]();
            }
        });
        this.proxies = [];
        this._stdin_callback = () => {throw new Error("No stdin callback registered!");};
        this._stdout_callback = () => {};
        this._stderr_callback = () => {};
    }

    interrupt_buffer(){
        return Comlink.transfer(this._interrupt_buffer);
    }

    start(){
        this._start_inner().then(this._result.resolve, this._result.reject);
    }

    async _start_inner(){
        pyodide.setInterruptBuffer(this._interrupt_buffer);
        try {
            return await exec_code(
                this._code, 
                this._validate_syntax.resolve, 
                this._stdin_callback,
                this._stdout_callback, 
                this._stderr_callback
            );
        } catch(e){
            let err = new Error(format_last_exception(e));
            this._validate_syntax.reject(err);
            throw err;
        } finally {
            pyodide.setInterruptBuffer();
        }
    }
    
    async validate_syntax(){
        // this._result.promise.catch(()=>{});
        return await this._validate_syntax.promise;
    }

    async result(){
        return await this._result.promise;
    }

    async setStdin(outer_stdin_reader){
        this.proxies.push(outer_stdin_reader);
        this._stdinReader = await new InnerStdinReader(outer_stdin_reader);
        this._stdin_callback = this._stdinReader._read.bind(this._stdinReader);
    }

    onStdout(callback){
        this.proxies.push(callback);
        this._stdout_callback = (msg) => callback(msg);
    }

    onStderr(callback){
        this.proxies.push(callback);
        this._stderr_callback = (msg) => callback(msg);
    }
}

function waitOnSizeBuffer(){
    while(true){
        let result = Atomics.wait(size_buffer, 1, 0, 50);
        if(result === "ok"){
            return;
        } else if(result === "timed-out"){
            pyodide.checkInterrupt();
        } else {
            throw Error("Unreachable?");
        }
    }
}

function outerWrap(innerWrap){
    function wrapper(...args){
        size_buffer[1] = 0;
        console.log("calling outer");
        innerWrap(...args);
        console.log("waiting");
        waitOnSizeBuffer();
        console.log("finished waiting");
        if(size_buffer[1] === 0){
            self.data_buffer = new Uint8Array(new SharedArrayBuffer(size_buffer[0]));
            set_data_buffer(self.data_buffer);
            waitOnSizeBuffer();
        }
        let size = size_buffer[0];
        let result = JSON.parse(decoder.decode(data_buffer.slice(0, size)));
        console.log(size);
        if(size_buffer[1] === 1){
            return result;
        } else if(size_buffer[1] === -1){
            let e = new Error();
            e.name = result.name;
            e.message = result.message;
            e.orig_stack = result.stack;
            throw e;
        }
    }
    return wrapper;
}

let decoder = new TextDecoder("utf-8");

class InnerStdinReader {
    constructor(stdin_reader){
        return (async () => {
            this.outer_reader = stdin_reader;
            [this._size, this._buffer] = await stdin_reader.buffers();
            return this;
        })();
    }

    _read(n){
        this.outer_reader._read(n);
        this._size[0] = 0;
        Atomics.wait(this._size, 0, 0);
        let size = this._size[0];
        if(size === -1){
            throw new Error("Stdin Cancelled");
        }
        // Can't use subarray, "the provided ArrayBufferView value must not be shared."
        return decoder.decode(this._buffer.slice(0, size));
    }
}

let blockingSleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function blockingSleep(t){
    for(let i = 0; i < t * 20; i++){
        Atomics.wait(blockingSleepBuffer, 0, 0, 50);
        pyodide.checkInterrupt();
    }
}
self.blockingSleep = blockingSleep;

let async_wrappers = {};
async function init(size_buffer, set_data_buffer, asyncWrappers){
    self.size_buffer = size_buffer;
    self.set_data_buffer = set_data_buffer;
    try {
        let key_list = await asyncWrappers.name_list;
        for(let key of key_list){
            let value = await asyncWrappers[key];
            async_wrappers[key] = outerWrap(value);
        }
    } catch(e) {
        console.error(e);
    }
    await languagePluginLoader;

    pyodide.registerJsModule("async_wrappers", async_wrappers);
    let mainPythonCode = await (await fetchPythonCode).text();
    let namespace = pyodide.pyimport("dict")();
    pyodide.pyodide_py.eval_code(mainPythonCode, namespace);
    for(let name of ["exec_code", "format_last_exception", "banner", "pycomplete"]){
        self[name] = namespace.get(name);
    }
    namespace.destroy();


    return Comlink.proxy({ 
        InnerExecution, 
        pyodide,
        banner,
        complete,
    });
}
Comlink.expose(init);
