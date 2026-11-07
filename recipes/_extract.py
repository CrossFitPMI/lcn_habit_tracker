import pymupdf, re, json
U="/mnt/user-data/uploads/Team Exceed/"
SRC=[("HIGH PROTEIN Guide Vol 1/HIGH PROTEIN GUIDE VOL 1_compressed.pdf","v1"),("HIGH PROTEIN Guide Vol 2/High Protein Recipe Guide Vol. 2.pdf","v2"),("Bonus Client Guides/High Fibre Veggie Sides.pdf","vs")]
TAGS={'GF','DF','LC','MP','HP','V','Q','N'}
def clean(t): return re.sub(r'\s+',' ',t.replace(' ',' ')).strip()
def lines_of(p):
    out=[]
    for bi,b in enumerate(p.get_text("dict")["blocks"]):
        if b.get("type")!=0: continue
        for l in b["lines"]:
            t="".join(s["text"] for s in l["spans"])
            if t.strip(): out.append(dict(b=bi,x0=l["bbox"][0],y0=l["bbox"][1],x1=l["bbox"][2],y1=l["bbox"][3],t=t.strip(),size=max(s["size"] for s in l["spans"])))
    return out
out=[]
for f,code in SRC:
    d=pymupdf.open(U+f)
    for i,p in enumerate(d):
        L=lines_of(p)
        hp=[l for l in L if l['t']=='Prep' and l['y0']>600]
        if not hp: continue
        hy=hp[0]['y0']
        heads=[l for l in L if abs(l['y0']-hy)<4]
        valsL=[l for l in L if hy+12<l['y0']<hy+45 and l['x0']>200]
        mac={}
        for v in valsL:
            cx=(v['x0']+v['x1'])/2; h=min(heads,key=lambda h:abs((h['x0']+h['x1'])/2-cx))
            mac[h['t']]=clean((mac.get(h['t'],'')+' '+v['t']))
        tl=[l for l in L if 60<l['y0']<175 and l['size']>=18]
        title=clean(' '.join(l['t'] for l in sorted(tl,key=lambda l:(l['y0'],l['x0']))))
        serves=next((clean(re.search(r'(Serves|Makes).*',l['t']).group(0)) for l in L if re.search(r'^(Serves|Makes)',l['t']) and l['y0']<245),None)
        tagl=[l for l in L if 600<l['y0']<hy and l['t'] in TAGS]
        tags=[l['t'] for l in sorted(tagl,key=lambda l:l['x0'])]
        bottom=min([l['y0'] for l in tagl]+[hy])-2
        body=[l for l in L if 240<l['y0']<bottom and not l['t'].startswith('*')]
        ingL=sorted([l for l in body if l['x0']<205],key=lambda l:l['y0'])
        ing=[]; prev=None
        for l in ingL:
            gap = l['y0']-prev['y1'] if prev else 99
            first=l['t'][:1]
            cont = prev is not None and not re.match(r'^(salt|black pepper|spray oil|oil spray|water|ice|handful)\b',l['t'],re.I) and gap<5 and (first.islower() or first in '(,&') and (prev['t'].rstrip().endswith((',','or','and','of','&')) or prev['x1']>160 or first in '(')
            if cont: ing[-1]+=' '+l['t']
            else: ing.append(l['t'])
            prev=l
        ing=[clean(x) for x in ing]
        mL=sorted([l for l in body if l['x0']>=205],key=lambda l:l['y0'])
        meth=[]; prev=None
        for l in mL:
            gap = l['y0']-prev['y1'] if prev else 99
            if prev is None or gap>5 or re.match(r'^\d+\.\s',l['t']): meth.append(l['t'])
            else: meth[-1]+=' '+l['t']
            prev=l
        meth=[re.sub(r'^\d+\.\s*','',clean(m)) for m in meth if clean(m)]
        img=None
        for j in (i-1,i):
            ims=sorted(d[j].get_images(full=True),key=lambda x:-(x[2]*x[3]))
            if ims and ims[0][2]*ims[0][3]>90000: img=[j,ims[0][0]]; break
        out.append(dict(src=code,page=i+1,title=title,serves=serves,tags=tags,ing=ing,method=meth,
            prep=mac.get('Prep'),cook=mac.get('Cook'),chill=mac.get('Chill'),kcal=mac.get('Kcal'),fat=mac.get('Fats(g)'),carbs=mac.get('Carbs(g)'),protein=mac.get('Protein(g)'),fibre=mac.get('Fibre(g)'),img=img))
json.dump(out,open('raw.json','w'),ensure_ascii=False,indent=1)
print(len(out))
for r in out:
    bad=not(r['ing'] and r['method'] and r['protein'] and r['img'] and r['serves'] and r['title'])
    print(r['src'],r['page'],r['title'][:50],'|',r['serves'],'|',len(r['ing']),'/',len(r['method']),'P',r['protein'],'K',r['kcal'],r['prep'],r['cook'],r['chill'] or '', '<<<' if bad else '')
