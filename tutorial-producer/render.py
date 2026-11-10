"""Render only verified, narrated real footage. No public publishing capability."""
import argparse, json, pathlib, subprocess, textwrap

def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def probe(path):
    return json.loads(run(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)]))

def validate(manifest):
    if manifest.get('status') != 'pass' or not manifest.get('scenes'):
        raise ValueError('Unverified capture cannot be rendered as a tutorial')
    for s in manifest['scenes']:
        if s['verification_status'] != 'pass' or not s.get('screenshot_paths') or not s.get('narration_text'):
            raise ValueError('Every scene requires passing proof and narration')
        if s['end'] <= s['start']:
            raise ValueError('Invalid scene timing')

def srt_time(t):
    ms=round(t*1000); seconds,ms=divmod(ms,1000); minutes,seconds=divmod(seconds,60); hours,minutes=divmod(minutes,60)
    return f'{hours:02}:{minutes:02}:{seconds:02},{ms:03}'

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--manifest',default='tutorial-output/manifest.json'); parser.add_argument('--dry-run',action='store_true'); args=parser.parse_args()
    path=pathlib.Path(args.manifest).resolve(); root=path.parent; manifest=json.loads(path.read_text()); validate(manifest)
    raw=root/'raw/video/raw.webm'
    if not raw.is_file(): raise ValueError('Real recorded footage missing')
    scenes=manifest['scenes']
    for s in scenes:
        s['audio']=root/'audio/narration'/f"{s['scene_id']}.mp3"
        if not s['audio'].is_file(): raise ValueError(f"Missing narration for {s['scene_id']}")
    if args.dry_run:
        print(f'{len(scenes)} verified scenes ready for rendering'); return
    export=root/'export'; export.mkdir(exist_ok=True); edit=root/'edits'; edit.mkdir(exist_ok=True)
    captions=[]; chapters=[]; elapsed=0
    for i,s in enumerate(scenes):
        audio_duration=float(probe(s['audio'])['format']['duration']); duration=max(s['end']-s['start'],audio_duration+0.5)
        clip=edit/f'{i:02}.mp4'
        scene_start=s.get('video_start',s['start']); scene_end=s.get('video_end',s['end'])
        capture_start=s.get('edit_start',scene_start); capture_end=s.get('edit_end',scene_end)
        if not scene_start <= capture_start < capture_end <= scene_end: raise ValueError('Edit exceeds verified scene')
        speed=float(s.get('edit_speed',1))
        if speed<1 or speed>2: raise ValueError('Only normal or up to 2x recorded actions allowed')
        duration=max((capture_end-capture_start)/speed,audio_duration+0.5)
        crop=s.get('crop')
        view=f'crop={crop[0]}:{crop[1]}:{crop[2]}:{crop[3]},' if crop else ('crop=iw:ih-16:0:16,' if manifest.get('capture_marker') else '')
        run(['ffmpeg','-v','error','-y','-ss',str(capture_start),'-t',str(capture_end-capture_start),'-i',str(raw),'-i',str(s['audio']),'-vf',f'setpts=PTS/{speed},'+view+'fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,tpad=stop_mode=clone:stop_duration='+str(duration),'-af','loudnorm=I=-16:TP=-1.5:LRA=11,apad','-t',str(duration),'-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-ac','2',str(clip)])
        # Sentence-level captions split into readable short chunks.
        words=s['narration_text'].split(); chunks=[' '.join(words[j:j+9]) for j in range(0,len(words),9)]
        for j,chunk in enumerate(chunks):
            start=elapsed+audio_duration*j/len(chunks); end=elapsed+audio_duration*(j+1)/len(chunks)
            captions.append(f'{len(captions)+1}\n{srt_time(start)} --> {srt_time(end)}\n{chunk}\n')
        chapters.append(f'{int(elapsed)//60:02}:{int(elapsed)%60:02} {s["learning_objective"]}')
        elapsed+=duration
    (edit/'concat.txt').write_text('\n'.join(f"file '{i:02}.mp4'" for i in range(len(scenes))))
    output=export/'portol-chat-to-trackers.mp4'
    run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',str(edit/'concat.txt'),'-c','copy','-movflags','+faststart',str(output)])
    (export/'captions.srt').write_text('\n'.join(captions))
    (export/'youtube-metadata.md').write_text('# Portol: Chat to Trackers\n\nA verified walkthrough using synthetic test data.\n\n'+'\n'.join(chapters)+'\n\nPublication requires owner approval.\n')
    media=probe(output); streams=media['streams']; v=next(x for x in streams if x['codec_type']=='video'); a=next(x for x in streams if x['codec_type']=='audio')
    assert (v['width'],v['height'],v['codec_name'],v['pix_fmt'])==(1920,1080,'h264','yuv420p')
    assert a['codec_name']=='aac'; assert abs(float(media['format']['duration'])-elapsed)<1
    run(['ffmpeg','-v','error','-i',str(output),'-f','null','-']) # Full decode integrity check.
    for n,fraction in enumerate([0.1,0.5,0.9]):
        run(['ffmpeg','-v','error','-y','-ss',str(elapsed*fraction),'-i',str(output),'-frames:v','1',str(export/f'qa-frame-{n}.png')])
    (export/'technical-qa.json').write_text(json.dumps({'technical':'pass','humanPlaybackReview':'pending','duration':elapsed,'publicPublishing':False},indent=2))
    print('Rendered and decoded MP4; playback/factual review still required.')
if __name__=='__main__': main()
