"""Builds the SIMULATED stand-in images for proof files 2 (scan) and 3 (phone photo).
Nothing here is a real scan or a real photo. Output: scan-standin.jpg, photo-standin.jpg
(wrapped into image-only PDFs by wrap_images.mjs, which embeds the JPEG bytes unchanged)."""
import subprocess, numpy as np, math, json
from PIL import Image, ImageFilter, ImageDraw
rng = np.random.default_rng(20261011)
def render(pdf, dpi=300):
    subprocess.run(['pdftoppm','-r',str(dpi),'-png','-singlefile',pdf,pdf[:-4]+'-300'],check=True)
    return Image.open(pdf[:-4]+'-300.png').convert('RGB')
def persp_coeffs(dst, src):
    # coefficients mapping output (dst) points -> input (src) points, as PIL expects
    A=[];B=[]
    for (x,y),(u,v) in zip(dst,src):
        A.append([x,y,1,0,0,0,-u*x,-u*y]); B.append(u)
        A.append([0,0,0,x,y,1,-v*x,-v*y]); B.append(v)
    return np.linalg.solve(np.array(A,float),np.array(B,float)).tolist()
meta={}
# ---------- (2) clean flatbed scan, simulated ----------
page = render('src/scan-standin.pdf')            # 2550x3300 @300dpi
W,H = 2620,3380                                   # scanner bed slightly larger than paper
bed = Image.new('RGB',(W,H),(68,70,72))           # dark scanner lid around the paper
ang = 1.6                                         # degrees tilt
rot = page.rotate(ang, resample=Image.BICUBIC, expand=True, fillcolor=(0,0,0))
mask = Image.new('L',page.size,255).rotate(ang, resample=Image.BICUBIC, expand=True, fillcolor=0)
ox,oy = (W-rot.width)//2+6,(H-rot.height)//2-4
bed.paste(rot,(ox,oy),mask)
a = np.asarray(bed).astype(np.float32)
a = a*np.array([0.985,0.975,0.955])+np.array([0,0,4])  # slightly warm paper
a += rng.normal(0,5.0,a.shape)                    # sensor noise
sp = rng.random(a.shape[:2])<0.0004; a[sp]=rng.uniform(60,140,(sp.sum(),1))  # dust specks
img = Image.fromarray(np.clip(a,0,255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))
img.save('scan-standin.jpg',quality=88,dpi=(300,300))
meta['scan']=dict(size=img.size,dpi=300,tilt_deg=ang,noise_sigma=5,jpeg_quality=88,simulated=True)
# ---------- (3) crooked phone photo, simulated ----------
page = render('src/photo-standin.pdf')           # 2550x3300
PW,PH = 3024,4032                                 # 12.2 MP portrait phone frame
yy,xx = np.mgrid[0:PH,0:PW].astype(np.float32)
wood = 120+25*np.sin(xx/37+3*np.sin(yy/410))+12*np.sin(xx/9.0+yy/300)+rng.normal(0,6,(PH,PW))
bg = np.stack([wood*1.05,wood*0.78,wood*0.55],-1)
# paper corners from a real pinhole-camera projection: f=3000 px (~26 mm-equivalent on a 4032 px frame),
# paper 8.5x11 in, camera pitched 13 deg, yawed 4 deg, rolled -6 deg, 14 in away, principal point at frame centre
def Rot(ax,ay,az):
    ax,ay,az=map(math.radians,(ax,ay,az))
    Rx=np.array([[1,0,0],[0,math.cos(ax),-math.sin(ax)],[0,math.sin(ax),math.cos(ax)]])
    Ry=np.array([[math.cos(ay),0,math.sin(ay)],[0,1,0],[-math.sin(ay),0,math.cos(ay)]])
    Rz=np.array([[math.cos(az),-math.sin(az),0],[math.sin(az),math.cos(az),0],[0,0,1]])
    return Rz@Ry@Rx
CAM=dict(f_px=3000,pitch_deg=13,yaw_deg=4,roll_deg=-6,distance_in=14)
P3=np.array([[-4.25,-5.5,0],[4.25,-5.5,0],[4.25,5.5,0],[-4.25,5.5,0]])
X=(Rot(CAM['pitch_deg'],CAM['yaw_deg'],CAM['roll_deg'])@P3.T).T+np.array([0,0,CAM['distance_in']])
c=np.array([[CAM['f_px']*x/z+PW/2, CAM['f_px']*y/z+PH/2] for x,y,z in X])
src = [(0,0),(page.width,0),(page.width,page.height),(0,page.height)]
coeffs = persp_coeffs([tuple(p) for p in c], src)
warped = page.transform((PW,PH), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=(0,0,0))
pm = Image.new('L',page.size,255).transform((PW,PH), Image.PERSPECTIVE, coeffs, Image.BICUBIC, fillcolor=0)
sh = pm.filter(ImageFilter.GaussianBlur(40))
bgimg = np.asarray(bg)*(1-0.55*np.asarray(sh,np.float32)[...,None]/255)  # soft shadow
m = np.asarray(pm,np.float32)[...,None]/255
a = bgimg*(1-m)+np.asarray(warped,np.float32)*np.array([0.97,0.95,0.90])*m
light = 0.62+0.42*np.clip(1-((xx-2600)**2+(yy-700)**2)**0.5/5200,0,1)   # lamp top-right, falls off
light -= 0.10*np.clip((yy-2400)/1600,0,1)*np.clip((1500-xx)/1500,0,1)     # hand shadow bottom-left
a = a*light[...,None]
a += rng.normal(0,4,a.shape)
img = Image.fromarray(np.clip(a,0,255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2.2))
small = img.resize((PW//2,PH//2), Image.LANCZOS)  # 12 MP capture downscaled 50% (as a messaging app would)
small.save('photo-standin.jpg',quality=72)
meta['photo']=dict(camera=CAM,capture_size=[PW,PH],saved_size=small.size,paper_corners_in_capture=c.tolist(),
  blur_px=2.2,jpeg_quality=72,lighting='radial falloff 0.62-1.04 + bottom-left shadow',simulated=True)
json.dump(meta,open('standins-meta.json','w'),indent=1)
print(meta)
