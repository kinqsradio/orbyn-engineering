const fs = require("node:fs");
const readline = require("node:readline");
const [scenario, record, cwd] = process.argv.slice(2);
const log = value => fs.appendFileSync(record, JSON.stringify(value) + "\n");
log({ pid: process.pid, processCwd: process.cwd() });
const send = value => fs.writeSync(1, JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const update = (kind, text, sessionId = "native") => send({ method: "session/update", params: { sessionId, update: { sessionUpdate: kind, content: { type: "text", text } } } });
const result = id => send({ id, result: {} });
let loading;
let replies = 0;
const history = id => { update("user_message_chunk", "old user"); update("agent_message_chunk", "old assistant"); result(id); };
readline.createInterface({input:process.stdin}).on("line", line => {
  const msg = JSON.parse(line);
  if (!msg.method) {
    log({reply:msg});
    if (++replies === 3) history(loading);
    return;
  }
  log(msg);
  const id = msg.id;
  if (msg.method === "initialize") {
    if (scenario === "init-error") return send({id,error:{code:-32002,message:"Unknown session"}});
    const sessionCapabilities = scenario === "unsupported" ? {} : {list:{},delete:{},...(["resume","both"].includes(scenario)?{resume:{}}:{})};
    return send({id,result:{protocolVersion:1,agentCapabilities:{loadSession:!["resume","unsupported"].includes(scenario),sessionCapabilities}}});
  }
  if (msg.method === "session/list") return send({id,result:{sessions:[{sessionId:"native",cwd,title:"Native",additionalDirectories:[]}],nextCursor:"next"}});
  if (msg.method === "session/delete") return result(id);
  if (msg.method === "session/new") return send({id,result:{sessionId:scenario === "oversize-id" ? "x".repeat(1025) : "new-native"}});
  if (["session/load","session/resume"].includes(msg.method)) {
    if (scenario === "hang") return;
    if (scenario === "unknown") return send({id,error:{code:-32002,message:"not a string classifier"}});
    if (scenario === "auth") return send({id,error:{code:-32000,message:"Unknown session"}});
    if (scenario === "wrong") { update("agent_message_chunk","foreign","other");return result(id); }
    if (scenario === "large-reply") return send({id,result:{extra:"x".repeat(4*1024*1024)}});
    if (scenario === "large-frame") {update("agent_message_chunk", "x".repeat(4*1024*1024));return result(id);}
    if (scenario === "oversize") { fs.writeSync(1, "x".repeat(4*1024*1024+1));return; }
    if (scenario === "flood") { for (let i=0;i<4097;i++) send({method:"notice",params:{}});return; }
    if (scenario === "requests") {
      loading=id;
      for (const [i,method] of ["session/request_permission","fs/read_text_file","terminal/create"].entries()) send({id:"client-"+i,method,params:{sessionId:"native"}});
      return;
    }
    if (msg.method === "session/resume") return result(id);
    return history(id);
  }
  if (msg.method === "session/prompt") {
    update("agent_message_chunk","new output",msg.params.sessionId);
    return send({id,result:{stopReason:"end_turn"}});
  }
  if (msg.method === "session/cancel") return;
  send({id,error:{code:-32601,message:"unsupported"}});
});
