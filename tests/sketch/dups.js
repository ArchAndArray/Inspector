const fs=require('fs'),acorn=require('/opt/npm-tools/node_modules/acorn');
const dir=process.argv[2]; const idx=fs.readFileSync(dir+'/index.html','utf8');
const order=[...idx.matchAll(/src="(js\/[^"]+)"/g)].map(m=>m[1]);
const seen={}; let bad=0;
for(const f of order){const ast=acorn.parse(fs.readFileSync(dir+'/'+f,'utf8'),{ecmaVersion:'latest'});
 for(const n of ast.body){const names=[];
  if(n.type==='FunctionDeclaration')names.push(n.id.name);
  if(n.type==='VariableDeclaration')n.declarations.forEach(d=>d.id.type==='Identifier'&&names.push(d.id.name));
  if(n.type==='ClassDeclaration')names.push(n.id.name);
  for(const nm of names){ if(seen[nm]){console.log('DUP',nm,seen[nm],f);bad++;} else seen[nm]=f; }}}
console.log('files',order.length,'dups',bad);
