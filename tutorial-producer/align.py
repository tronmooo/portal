"""Find actual scene boundaries from temporary 16px capture markers, removed by the renderer."""
import json,pathlib,subprocess
root=pathlib.Path('tutorial-output');p=root/'manifest.json';m=json.loads(p.read_text())
if m['status']!='pass': raise ValueError('Only align verified captures')
raw=root/'raw/video/raw.webm'
colors=[(250,0,250),(0,250,0),(0,0,250),(250,250,0),(0,250,250)]
frames=subprocess.run(['ffmpeg','-v','error','-i',str(raw),'-vf','fps=25,crop=8:8:20:4,scale=1:1,format=rgb24','-f','rawvideo','-'],capture_output=True,check=True).stdout
first={}
for i in range(0,len(frames),3):
 pixel=frames[i:i+3]
 if len(pixel)!=3: continue
 distances=[sum((pixel[j]-c[j])**2 for j in range(3)) for c in colors]
 index=min(range(len(colors)),key=distances.__getitem__)
 if distances[index]<2500 and index not in first: first[index]=i/3/25
if set(first)!=set(range(len(m['scenes']))): raise ValueError('Missing scene markers; no automatic export allowed')
bounds=[first[i] for i in range(len(m['scenes']))]+[len(frames)/3/25]
if bounds!=sorted(bounds): raise ValueError('Scene markers out of order')
for i,s in enumerate(m['scenes']): s.update(video_start=bounds[i],video_end=bounds[i+1],timecode_source='recorded-frame-marker')
m['capture_marker']=True;p.write_text(json.dumps(m,indent=2));print('Aligned verified scenes against recorded frames')
