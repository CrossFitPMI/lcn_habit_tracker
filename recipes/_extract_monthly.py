import pymupdf, re, json, io, os
from wordfreq import zipf_frequency as zf
from PIL import Image
U="/mnt/user-data/uploads/Team Exceed/recipe books to edit /"
PACKS=[("Nov 24 Recipe Pack.pdf","nov"),("Dec 2024 Recipe Pack.pdf","dec"),("Jan 2025 Recipe Pack.pdf","jan")]
TAGS={'GF','DF','LC','MP','HP','V','Q','N'}
FIX=[(r'\bt hrough\b','through'),(r'\s+',' ')]
def tidy(t):
    for a,b in FIX: t=re.sub(a,b,t)
    return t.strip()
def lines_of(p):
    out=[]
    for b in p.get_text("dict")["blocks"]:
        if b.get("type")!=0: continue
        for l in b["lines"]:
            raw="".join(s["text"] for s in l["spans"])
            if raw.strip(): out.append(dict(x0=l["bbox"][0],y0=l["bbox"][1],x1=l["bbox"][2],y1=l["bbox"][3],raw=raw,t=raw.strip(),size=max(s["size"] for s in l["spans"])))
    return out
def group(L,maxgap):
    items=[]; prev=None
    for l in sorted(L,key=lambda l:l['y0']):
        if prev is None or l['y0']-prev['y1']>maxgap: items.append(l['raw'])
        else:
            a=items[-1]; b=l['raw']
            # the PDF keeps word-boundary spaces on one side of the break; a mid-word break has none
            if not a.endswith(' ') and not b.startswith(' '):
                ta=re.search(r'([A-Za-z]+)$',a); hb=re.match(r'([A-Za-z]+)',b)
                if re.search(r'[,.;:)]$',a): a+=' '
                elif ta and hb:
                    j=ta.group(1)+hb.group(1)
                    if zf(j.lower(),'en')<2.5 and zf(ta.group(1).lower(),'en')>=2 and zf(hb.group(1).lower(),'en')>=2: a+=' '
            items[-1]=a+b
        prev=l
    return [tidy(x) for x in items if tidy(x)]
out=[]
for f,code in PACKS:
    d=pymupdf.open(U+f); idx=0
    for i,p in enumerate(d):
        L=lines_of(p)
        en=[l for l in L if l['t']=='Energy' and l['y0']>600]
        if not en: continue
        idx+=1
        hy=en[0]['y0']; heads=[l for l in L if abs(l['y0']-hy)<4 and l['t'] in('Energy','Carbs','Protein','Fat')]
        vals=[l for l in L if hy+15<l['y0']<hy+40]
        mac={}
        for v in vals:
            cx=(v['x0']+v['x1'])/2; h=min(heads,key=lambda h:abs((h['x0']+h['x1'])/2-cx)); mac[h['t']]=v['t']
        num=lambda s: int(re.match(r'\d+',s).group()) if s and re.match(r'\d+',s) else None
        title=' '.join(l['t'] for l in sorted([l for l in L if l['size']>=20 and l['y0']<150],key=lambda l:l['y0']))
        serves=next((l['t'] for l in L if re.match(r'^(Serves|Makes)',l['t'])),None)
        tot=next((l['t'] for l in L if re.search(r'(Minutes?|Hours?|Mins?)$',l['t'],re.I) and l['y0']<190),None)
        tagl=[l for l in L if 600<l['y0']<hy and l['t'] in TAGS]
        top=185; bottom=min([l['y0'] for l in tagl]+[hy])-2
        body=[l for l in L if top<l['y0']<bottom and 'nutrition.com' not in l['t']]
        ing=group([l for l in body if l['x0']<215],6)
        meth=group([l for l in body if l['x0']>=215],8)
        ims=sorted(d[i-1].get_images(full=True),key=lambda x:-(x[2]*x[3]))
        n=len(out)
        t=title
        if re.search(r'smoothie(?! bowl)',t,re.I): c='Smoothies'
        elif re.search(r'\bshots?\b',t,re.I): c='Snacks & Treats'
        elif idx<=4 and not re.search(r'wrap|patties|salad',t,re.I): c='Breakfast'
        elif idx>=13: c='Snacks & Treats'
        else: c='Lunch & Dinner'
        sv=re.search(r'(\d+)',serves or '')
        out.append(dict(src=code+':'+str(i+1),t=t,c=c,s=serves,sv=int(sv.group(1)) if sv else None,tot=(tot.replace('Minutes','mins').replace('Minute','min') if tot else None),
            prep=None,cook=None,chill=None,kcal=num(mac.get('Energy')),p=num(mac.get('Protein')),cb=num(mac.get('Carbs')),f=num(mac.get('Fat')),fi=None,
            tags=[l['t'] for l in sorted(tagl,key=lambda l:l['x0'])],ing=ing,m=meth,_img=(code,i-1,ims[0][0] if ims else None)))
json.dump(out,open('monthly.json','w'),ensure_ascii=False,indent=1)
print(len(out))
for r in out: print(r['src'],r['c'][:9],'|',r['t'],'|',r['s'],r['tot'],'|',len(r['ing']),'/',len(r['m']),'P',r['p'],'K',r['kcal'],r['tags'], '<<<' if not(r['ing'] and r['m'] and r['p'] is not None and r['_img'][2]) else '')
