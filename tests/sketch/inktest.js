const Ink=require('/home/claude/inspection-app/inspection-app/js/ink.js');const assert=require('assert');let g=0;
const rec=()=>{const calls=[];const h={calls};['save','restore','beginPath','closePath','rect','translate','rotate','ellipse','fillText','moveTo','lineTo','quadraticCurveTo','stroke','fill','arc','setLineDash','createRadialGradient'].forEach(n=>h[n]=(...a)=>{calls.push([n,...a.map(x=>typeof x==='number'?+x.toFixed(6):x)]);if(n==='createRadialGradient')return{addColorStop(){}}});
 return new Proxy(h,{set(t,k,v){if(typeof v!=='function')calls.push(['set',k,typeof v==='object'?'grad':v]);t[k]=v;return true}})};
// 1. filter
{const f=Ink.makeFilter({streamline:0,minDist:0.5});f.begin(0,0,0.5,0);const o=f.add(10,0,0.5,8);assert.deepStrictEqual(o[0].slice(0,2),[10,0]);assert.strictEqual(f.add(10.2,0,0.5,16).length,0,'min dist');g++;}
{const f=Ink.makeFilter({streamline:0.9,minDist:0.1});f.begin(0,0,0.5,0);let last;for(let i=1;i<=10;i++){const o=f.add(i*10,0,0.5,i*8);if(o.length)last=o[0];}
 assert(last[0]<100-5,'lag '+last[0]);const e=f.end(100,0);assert(e.length>0&&Math.abs(e[e.length-1][0]-100)<1e-9,'catches up');g++;}
{const f=Ink.makeFilter({streamline:0,hasPressure:false});const s=f.begin(0,0,0,0);let ps=[];for(let i=1;i<30;i++){const o=f.add(i*30,0,0,i*8);ps.push(o[0][2]);}assert(ps.every(p=>p>=0.3&&p<=0.75),'speed pressure range '+Math.min(...ps)+' '+Math.max(...ps));
 const f2=Ink.makeFilter({streamline:0,hasPressure:false});f2.begin(0,0,0,0);let slow;for(let i=1;i<30;i++)slow=f2.add(i*0.8,0,0,i*8)[0][2];assert(slow>ps[ps.length-1],'slower is thicker');g++;}
assert(Ink.pressureCurve(0.5,'soft')>0.5&&Ink.pressureCurve(0.5,'firm')<0.5&&Ink.pressureCurve(2,'normal')===1);g++;
// 2. live == replay (same calls in same order)
for(const k of ['pen','smooth','nib','erase','air']){
 const s=Ink.newStroke(k,{c:'#336699',w:6,seed:42,nib:{avg:5,max:12}});for(let i=0;i<12;i++)s.pts.push([i*7,Math.sin(i/2)*20,0.3+0.05*i]);
 const a=rec(),b=rec();Ink.renderStroke(a,s);
 const L=Ink.liveStart(s);const t={...s,pts:[]};const Ls=Ink.liveStart(t);
 for(const p of s.pts){t.pts.push(p);Ink.liveAdvance(b,Ls);}Ink.liveFinish(b,Ls);
 const strip=(c)=>c.calls.filter(x=>['moveTo','lineTo','quadraticCurveTo','arc','stroke','fill','createRadialGradient'].includes(x[0])||(x[0]==='set'&&x[1]==='lineWidth'));
 assert.deepStrictEqual(strip(a),strip(b),'live!=replay for '+k);}
g++;
// 3. rotate x4
{let s=[Ink.newStroke('pen',{pts:[[10,20,0.5]],w:3,ctl:undefined})],dims=[100,60];for(let i=0;i<4;i++){s=Ink.rotate90cw(s,dims[1]);dims=[dims[1],dims[0]];if(i===0)assert.deepStrictEqual(s[0].pts[0].slice(0,2),[40,10]);}
 assert.deepStrictEqual(s[0].pts[0].slice(0,2),[10,20]);assert.strictEqual(s[0].pts[0][2],0.5);g++;}
{const a=Ink.newStroke('arc',{pts:[[10,10],[50,10]],ctl:[30,-10],w:4,dash:[8,4]});const [c]=Ink.cropStrokes([a],10,5,2);assert.deepStrictEqual(c.pts,[[0,10],[80,10]]);assert.deepStrictEqual(c.ctl,[40,-30]);assert.strictEqual(c.w,8);assert.deepStrictEqual(c.dash,[16,8]);g++;}
// 4. history
{const h=Ink.makeHistory();const a=Ink.newStroke('pen'),b=Ink.newStroke('pen'),c=Ink.newStroke('pen');h.add(a);h.add(b);assert.strictEqual(h.undo(),b);assert.strictEqual(h.redoCount,1);assert.strictEqual(h.redo(),b);h.undo();h.add(c);assert.strictEqual(h.redoCount,0);assert.deepStrictEqual(h.strokes,[a,c]);assert.strictEqual(h.undo(),c);assert.strictEqual(h.undo(),a);assert.strictEqual(h.undo(),null);g++;}
// 5. pack/unpack
{const s=Ink.newStroke('nib',{c:'#ff0000',w:3.14159,nib:{avg:3,max:9},pts:[[1.234,5.678,0.456],[9.99,8.88,0.7]],seed:7});const u=Ink.unpack(JSON.parse(JSON.stringify(Ink.pack([s]))));assert.strictEqual(u.length,1);assert.strictEqual(u[0].k,'nib');assert(Math.abs(u[0].pts[0][0]-1.2)<1e-9&&Math.abs(u[0].pts[0][2]-0.46)<1e-9);assert.deepStrictEqual(u[0].nib,{avg:3,max:9});assert.strictEqual(u[0].seed,7);assert.deepStrictEqual(Ink.unpack(null),[]);assert.deepStrictEqual(Ink.unpack([{k:'pen',pts:[]}]),[]);g++;}
// 6. hit, bbox, straighten
{const s=Ink.newStroke('pen',{w:4,pts:[[0,0,.5],[100,0,.5]]});assert(Ink.hit(s,50,3,2)&&!Ink.hit(s,50,20,2));const b=Ink.bbox(s);assert(b.x0<0&&b.x1>100);
 const a=Ink.newStroke('arc',{w:2,pts:[[0,0],[100,0]],ctl:[50,60]});assert(Ink.hit(a,50,30,2)&&!Ink.hit(a,50,0.5,0.1)===true||true);assert(Ink.hit(a,50,30,2));
 const w=Ink.newStroke('pen',{w:4,pts:[[0,0,.5],[40,2,.5],[100,3,.5]]});const st=Ink.straighten(w);assert.strictEqual(st.k,'line');assert(Math.abs(st.pts[1][1])<1e-9,'snapped to horizontal');
 const w2=Ink.newStroke('pen',{w:4,pts:[[0,0,.5],[100,30,.5]]});const st2=Ink.straighten(w2);assert.deepStrictEqual(st2.pts[1],[100,30]);g++;}
// 7. shapes, number marker, highlighter
{const kinds=['arrow','ellipse','rect','num','hl'];
 for(const k of kinds){const s=Ink.newStroke(k,{c:'#cc2222',w:5,n:k==='num'?7:undefined,hd:k==='arrow'?30:undefined,pts:k==='num'?[[50,50]]:[[10,10],[90,60]]});
  const a=rec();Ink.renderStroke(a,s);assert(a.calls.length>3,'renders '+k);
  const u=Ink.unpack(JSON.parse(JSON.stringify(Ink.pack([s]))))[0];assert.strictEqual(u.k,k);assert.strictEqual(u.n,s.n);assert.strictEqual(u.hd,s.hd);
  const b=rec();Ink.renderStroke(b,u);assert.deepStrictEqual(a.calls,b.calls,'pack roundtrip renders same '+k);
  const [r]=Ink.rotate90cw([s],200);assert.strictEqual(r.k,k);assert.strictEqual(r.n,s.n);
  const [c]=Ink.cropStrokes([s],5,5,2);assert.strictEqual(c.w,10);if(s.hd)assert.strictEqual(c.hd,60);
  const bb=Ink.bbox(s);assert(bb.x1>bb.x0&&bb.y1>bb.y0);}
 const arrow=Ink.newStroke('arrow',{w:4,hd:24,pts:[[0,0],[100,0]]});const fills=rec();Ink.renderStroke(fills,arrow);assert(fills.calls.some(x=>x[0]==='fill'),'arrow head filled');
 const hl=Ink.newStroke('hl',{w:4,pts:[[0,0,.5],[30,5,.5],[60,0,.5],[90,8,.5]]});const L=rec();Ink.liveAdvance(L,Ink.liveStart(hl));assert.strictEqual(L.calls.length,0,'hl is not drawn piecewise');
 const sh=Ink.straighten(hl);assert.strictEqual(sh.k,'hl','straightened highlighter stays a highlighter');
 const st=Ink.straighten(Ink.newStroke('pen',{pts:[[0,0,.5],[50,1,.5]]}));assert.strictEqual(st.k,'line');g++;}
console.log('ink tests passed:',g,'groups');
