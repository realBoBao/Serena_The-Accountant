#!/usr/bin/env python3
"""
scripts/generate_recap_video.py — Generate recap video from text summary

Uses edge-tts (free TTS) + moviepy to create a simple video with:
- Text overlay (key points)
- Voice narration (Vietnamese)
- Background music (optional)

Usage:
  python scripts/generate_recap_video.py --text "Tóm tắt bài học..." --output recap.mp4

Requirements:
  pip install edge-tts moviepy Pillow
"""

import argparse
import os
import sys
import tempfile
import subprocess

def generate_video(text, output_path, voice="vi-VN-HoaiMyNeural"):
    """Generate a simple recap video from text."""
    try:
        import edge_tts
        from moviepy.editor import *
        from moviepy.video.fx.all import fadein, fadeout
        from PIL import Image, ImageDraw, ImageFont
        import asyncio
    except ImportError as e:
        print(f"Missing dependency: {e}")
        print("Install: pip install edge-tts moviepy Pillow")
        sys.exit(1)

    async def main():
        # 1. Generate TTS audio
        print("[RecapVideo] Generating TTS audio...")
        audio_path = os.path.join(tempfile.gettempdir(), "recap_audio.mp3")
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(audio_path)

        # 2. Create text frames
        print("[RecapVideo] Creating video frames...")
        lines = [l.strip() for l in text.split('\n') if l.strip()][:10]  # Max 10 lines
        clips = []

        for i, line in enumerate(lines):
            # Create image with text
            img = Image.new('RGB', (1280, 720), color=(15, 23, 42))
            draw = ImageDraw.Draw(img)

            # Try to use a nice font, fallback to default
            try:
                font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 36)
                small_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 24)
            except:
                font = ImageFont.load_default()
                small_font = font

            # Draw title
            title = f"📚 Learning Recap ({i+1}/{len(lines)})"
            draw.text((640, 100), title, fill=(99, 102, 241), font=font, anchor="mm")

            # Draw content
            # Wrap text to fit
            words = line.split()
            wrapped_lines = []
            current_line = ""
            for word in words:
                test = current_line + " " + word if current_line else word
                bbox = draw.textbbox((0, 0), test, font=small_font)
                if bbox[2] < 1100:
                    current_line = test
                else:
                    if current_line:
                        wrapped_lines.append(current_line)
                    current_line = word
            if current_line:
                wrapped_lines.append(current_line)

            y_start = 250
            for j, wl in enumerate(wrapped_lines[:8]):  # Max 8 lines per frame
                draw.text((640, y_start + j * 50), wl, fill=(226, 232, 240), font=small_font, anchor="mm")

            # Save frame
            frame_path = os.path.join(tempfile.gettempdir(), f"frame_{i:03d}.png")
            img.save(frame_path)

            # Create clip (3 seconds per frame)
            clip = ImageClip(frame_path).set_duration(4)
            clip = fadein(clip, 0.5)
            clip = fadeout(clip, 0.5)
            clips.append(clip)

        if not clips:
            print("[RecapVideo] No content to display")
            sys.exit(1)

        # 3. Concatenate clips
        print("[RecapVideo] Concatenating video...")
        video = concatenate_videoclips(clips, method="compose")

        # 4. Add audio
        print("[RecapVideo] Adding audio...")
        audio = AudioFileClip(audio_path)
        # Trim or loop audio to match video duration
        if audio.duration > video.duration:
            audio = audio.subclip(0, video.duration)
        video = video.set_audio(audio)

        # 5. Write output
        print(f"[RecapVideo] Writing to {output_path}...")
        video.write_videofile(output_path, fps=24, codec='libx264', audio_codec='aac', threads=4)

        # Cleanup
        for c in clips:
            try: os.close(c.reader)
            except: pass
        try: os.unlink(audio_path)
        except: pass
        for i in range(len(lines)):
            try: os.unlink(os.path.join(tempfile.gettempdir(), f"frame_{i:03d}.png"))
            except: pass

        print(f"[RecapVideo] ✅ Done: {output_path}")

    asyncio.run(main())

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate recap video from text")
    parser.add_argument("--text", required=True, help="Text content for the video")
    parser.add_argument("--output", default="recap.mp4", help="Output video path")
    parser.add_argument("--voice", default="vi-VN-HoaiMyNeural", help="TTS voice")
    args = parser.parse_args()

    generate_video(args.text, args.output, args.voice)
