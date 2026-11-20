"""Extract a positioned text model from a PDF (same shape the in-Foundry pdf.js reader produces).
Output: {"title":..., "pages":[{"n":1,"w":..,"h":..,"items":[[str,x,y,w,size,bold,italic],...]}]}"""
import sys, json, re, pdfplumber
src, out = sys.argv[1], sys.argv[2]
pages=[]
with pdfplumber.open(src) as pdf:
    for i,p in enumerate(pdf.pages):
        try:
            words=p.extract_words(extra_attrs=["fontname","size"], keep_blank_chars=False, use_text_flow=False, x_tolerance=1.5)
        except Exception as e:
            words=[]
        items=[]
        for w in words:
            fn=w.get("fontname","").split("+")[-1]
            st=fn.split("-")[-1] if "-" in fn else fn
            bold=bool(re.search(r"bold|black|heavy|semibold|demi|^bd|bd(it)?$|^sb|smbd|^hv", st, re.I) or re.search(r"bold|black", fn, re.I))
            ital=bool(re.search(r"italic|oblique|it$|^it", st, re.I))
            items.append([w["text"], round(w["x0"],1), round(w["top"],1), round(w["x1"]-w["x0"],1), round(w["size"],1),
                          1 if bold else 0, 1 if ital else 0, fn])
        pages.append({"n":i+1,"w":round(p.width,1),"h":round(p.height,1),"items":items})
        if i%50==0: print(i, file=sys.stderr)
json.dump({"title":src.split("/")[-1],"pages":pages}, open(out,"w"))
