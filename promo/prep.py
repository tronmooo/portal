"""Compose screen textures for the promo: python prep.py <shots_dir> <tex_dir>"""
from PIL import Image, ImageDraw, ImageFilter
import sys, os, shutil
M=sys.argv[1]; T=sys.argv[2]
def rounded(im, r):
    m=Image.new("L", im.size, 0); ImageDraw.Draw(m).rounded_rectangle([0,0,*im.size], r, fill=255)
    out=Image.new("RGBA", im.size); out.paste(im.convert("RGBA"), (0,0), m); return out
def lap(cols, name, W=2560, H=1600):
    bg=Image.new("RGB",(W,H),(13,14,17))
    g=Image.new("L",(W,H)); gd=ImageDraw.Draw(g)
    for i in range(H): gd.line([(0,i),(W,i)], fill=int(18*(i/H)))
    bg=Image.composite(Image.new("RGB",(W,H),(20,30,48)), bg, g)
    side=Image.open(f"{M}/desktop-dashboard.png").convert("RGB")
    sw=int(side.width*165/1440); sb=side.crop((0,0,sw,int(side.height*0.42)))
    sb=sb.resize((int(sb.width*H/side.height*1.0), int(sb.height*H/side.height)))
    bg.paste(sb,(0,0)); ImageDraw.Draw(bg).line([(sb.width,0),(sb.width,H)], fill=(32,34,40), width=2)
    x0=sb.width+60; gap=50; ch=H-120; n=len(cols)
    cw=(W-x0-60-gap*(n-1))//n
    for i,c in enumerate(cols):
        im=Image.open(f"{M}/{c}.png").convert("RGB")
        sc=cw/im.width; im=im.resize((cw,int(im.height*sc)), Image.LANCZOS)
        im=im.crop((0,0,cw,min(ch,im.height)))
        x=x0+i*(cw+gap); y=60
        sh=Image.new("RGBA",(cw+80,im.height+80),(0,0,0,0)); ImageDraw.Draw(sh).rounded_rectangle([40,50,cw+40,im.height+40],36,fill=(0,0,0,170))
        sh=sh.filter(ImageFilter.GaussianBlur(22)); bg.paste(sh,(x-40,y-40),sh)
        r=rounded(im,36); bg.paste(r,(x,y),r)
        ImageDraw.Draw(bg).rounded_rectangle([x,y,x+cw,y+im.height],36,outline=(60,66,80),width=2)
    bg.save(f"{T}/{name}.png")
lap(["chat-typing","dashboard","wellness"],"lap_chat1")
lap(["chat-reply","dashboard","wellness"],"lap_chat2")
lap(["dashboard","finance","calendar"],"lap_dash")
# phone screens: crop status bar off? keep full; save resized 1170x2532
for f in ["dashboard","finance","calendar","tasks","wellness","habits","obligations","journal","trackers","chat-reply","chat-reply2","goals","dashboard-2","finance-2","wellness-2","insights","calendar-2"]:
    Image.open(f"{M}/{f}.png").convert("RGB").resize((780,1688), Image.LANCZOS).save(f"{T}/ph_{f}.png")
m=Image.new("L",(780,1688),0); ImageDraw.Draw(m).rounded_rectangle([0,0,779,1687],105,fill=255); m.save(f"{T}/phone_mask.png")
m=Image.new("L",(390,844),0); ImageDraw.Draw(m).rounded_rectangle([0,0,389,843],20,fill=255); m.save(f"{T}/card_mask.png")
shutil.copy(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../client/public/portol-logo-square.png"), f"{T}/logo.png")
print("ok")
