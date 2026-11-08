/**
 * @file The small script placed at the top of every preview document.
 *
 * It runs inside the sandboxed preview frame (opaque origin, no access
 * to BrowserOS) and only talks to the parent through postMessage:
 *
 *   console   console.log/info/warn/error/debug/table calls, as text
 *   error     uncaught errors and unhandled promise rejections, with the
 *             project file and line they came from
 *   navigate  a click on a link to another HTML file of the project
 *   scroll    the page's scroll position, so a rebuild can restore it
 *   ready     the page finished loading
 *
 * Because the frame has an opaque origin, the browser blocks Web
 * Storage there; the bridge installs in-memory localStorage and
 * sessionStorage so pages that use them keep working (their contents
 * last until the preview reloads).
 *
 * The script is emitted on a single line so inserting it never shifts
 * the line numbers of the page's own code.
 */

/**
 * @param {{token: string, entryPath: string, scroll: [number, number]}} config
 * @returns {string} A single-line <script> element.
 */
export function createBridgeScript(config) {
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  const source = BRIDGE_SOURCE.replace("__CONFIG__", json);
  return `<script data-code-studio-bridge>${source}</script>`;
}

const BRIDGE_SOURCE = [
  "(function(){",
  "var C=__CONFIG__;",
  "var P=window.parent;",
  "function send(m){m.codeStudioPreview=C.token;try{P.postMessage(m,'*');}catch(e){}}",
  "function fmt(v,d){d=d||0;try{",
  "if(typeof v==='string')return d?JSON.stringify(v):v;",
  "if(v===undefined)return 'undefined';if(v===null)return 'null';",
  "if(typeof v==='function')return 'function '+(v.name||'(anonymous)')+'()';",
  "if(typeof v==='symbol'||typeof v==='bigint')return String(v)+(typeof v==='bigint'?'n':'');",
  "if(v instanceof Error)return v.name+': '+v.message;",
  "if(typeof Element!=='undefined'&&v instanceof Element){return '<'+v.tagName.toLowerCase()+(v.id?' id=\"'+v.id+'\"':'')+(v.className&&typeof v.className==='string'?' class=\"'+v.className+'\"':'')+'>';}",
  "if(typeof v!=='object')return String(v);",
  "if(d>2)return Array.isArray(v)?'[\u2026]':'{\u2026}';",
  "if(Array.isArray(v)){var a=[];for(var i=0;i<v.length&&i<50;i++)a.push(fmt(v[i],d+1));if(v.length>50)a.push('\u2026 '+(v.length-50)+' more');return '['+a.join(', ')+']';}",
  "if(v instanceof Map){var m=[];v.forEach(function(x,k){if(m.length<30)m.push(fmt(k,d+1)+' => '+fmt(x,d+1));});return 'Map('+v.size+') {'+m.join(', ')+'}';}",
  "if(v instanceof Set){var s=[];v.forEach(function(x){if(s.length<30)s.push(fmt(x,d+1));});return 'Set('+v.size+') {'+s.join(', ')+'}';}",
  "var keys=Object.keys(v),o=[];for(var j=0;j<keys.length&&j<30;j++){o.push(keys[j]+': '+fmt(v[keys[j]],d+1));}if(keys.length>30)o.push('\u2026');",
  "var n=v.constructor&&v.constructor.name&&v.constructor.name!=='Object'?v.constructor.name+' ':'';",
  "return n+'{'+o.join(', ')+'}';",
  "}catch(e){return '[unprintable]';}}",
  "function where(){try{throw new Error();}catch(e){var lines=String(e.stack||'').split('\\n');for(var i=0;i<lines.length;i++){var r=loc(lines[i]);if(r)return r;}}return null;}",
  "function pathOf(file){if(!file)return null;if(file==='about:srcdoc'||file===location.href)return C.entryPath;var m=/^data:[^,]*;x-path=([^;,]+)/.exec(file);return m?decodeURIComponent(m[1]):null;}",
  "function loc(line){var m=/((?:data:[^\\s)]*?;x-path=[^;,\\s)]+[^\\s)]*|about:srcdoc)):(\\d+):(\\d+)/.exec(line);if(!m||/data-code-studio-bridge/.test(line))return null;var p=pathOf(m[1]);if(!p)return null;if(p===C.entryPath&&bridgeLine&&+m[2]===bridgeLine&&+m[3]<bridgeEnd)return null;return {path:p,line:+m[2],column:+m[3]};}",
  "var bridgeLine=C.bridgeLine||0,bridgeEnd=C.bridgeEnd||0;",
  "['log','info','warn','error','debug','table','trace','dir'].forEach(function(level){var orig=console[level];console[level]=function(){var args=[];for(var i=0;i<arguments.length;i++)args.push(fmt(arguments[i]));",
  "send({type:'console',level:level==='table'||level==='dir'||level==='trace'?'log':level,text:args.join(' '),at:where()});if(orig)try{orig.apply(console,arguments);}catch(e){}};});",
  "var origClear=console.clear;console.clear=function(){send({type:'clear'});if(origClear)try{origClear.call(console);}catch(e){}};",
  "window.addEventListener('error',function(e){if(e.target&&e.target!==window&&e.target.tagName){var t=e.target,u=t.getAttribute('src')||t.getAttribute('href')||'';",
  "send({type:'console',level:'error',text:'Couldn\\u2019t load <'+t.tagName.toLowerCase()+'> '+(u.slice(0,5)==='data:'?'resource':u),at:null});return;}",
  "var p=pathOf(e.filename);send({type:'error',message:String(e.message||'Error').replace(/^Uncaught /,''),path:p,line:e.lineno||0,column:e.colno||0,stack:e.error&&e.error.stack?String(e.error.stack).slice(0,2000):''});},true);",
  "window.addEventListener('unhandledrejection',function(e){var r=e.reason;var at=null;if(r&&r.stack){var l=String(r.stack).split('\\n');for(var i=0;i<l.length&&!at;i++)at=loc(l[i]);}",
  "send({type:'error',message:'Unhandled promise rejection: '+fmt(r),path:at?at.path:null,line:at?at.line:0,column:at?at.column:0,stack:''});});",
  "function mem(){var d=Object.create(null);return{get length(){return Object.keys(d).length;},key:function(i){var k=Object.keys(d);return i<k.length?k[i]:null;},",
  "getItem:function(k){k=String(k);return k in d?d[k]:null;},setItem:function(k,v){d[String(k)]=String(v);},removeItem:function(k){delete d[String(k)];},clear:function(){d=Object.create(null);}};}",
  "['localStorage','sessionStorage'].forEach(function(n){var ok=false;try{ok=!!window[n];}catch(e){}if(!ok){try{Object.defineProperty(window,n,{value:mem(),configurable:true});}catch(e){}}});",
  "document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[data-cs-href]'):null;if(!a||e.defaultPrevented||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey)return;",
  "e.preventDefault();send({type:'navigate',path:a.getAttribute('data-cs-href'),hash:a.getAttribute('data-cs-hash')||''});},false);",
  "var st=0;window.addEventListener('scroll',function(){clearTimeout(st);st=setTimeout(function(){send({type:'scroll',x:window.scrollX,y:window.scrollY});},120);},{passive:true});",
  "window.addEventListener('load',function(){if(C.scroll&&(C.scroll[0]||C.scroll[1]))window.scrollTo(C.scroll[0],C.scroll[1]);send({type:'ready',title:document.title||''});});",
  "})();",
].join("");
