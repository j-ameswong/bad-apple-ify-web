"""Make small, deterministic videos for the browser integration tests."""

from pathlib import Path
import subprocess
import sys


def ffmpeg(*args: str) -> None:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
        check=True,
    )


def video(path: Path, *, seconds: int, audio: bool, audio_offset: float = 0) -> None:
    inputs = ["-f", "lavfi", "-i", f"testsrc2=size=96x72:rate=16:duration={seconds}"]
    if audio:
        inputs += [*( ["-itsoffset", str(audio_offset)] if audio_offset else []), "-f", "lavfi", "-i", f"sine=frequency=660:sample_rate=48000:duration={seconds}"]
    ffmpeg(
        *inputs,
        "-map", "0:v:0",
        *(["-map", "1:a:0"] if audio else []),
        "-c:v", "libvpx-vp9", "-deadline", "good", "-cpu-used", "5",
        "-b:v", "0", "-crf", "36", "-pix_fmt", "yuv420p",
        *(["-c:a", "libopus", "-b:a", "48k"] if audio else []),
        "-threads", "2", str(path),
    )


def main() -> None:
    directory = Path(sys.argv[1])
    directory.mkdir(parents=True, exist_ok=True)
    video(directory / "source.webm", seconds=3, audio=True)
    video(directory / "delayed-audio.webm", seconds=3, audio=True, audio_offset=0.25)
    video(directory / "long-source.webm", seconds=6, audio=True)
    video(directory / "gallery.webm", seconds=2, audio=False)
    ffmpeg(
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30000/1001:duration=1",
        "-c:v", "libvpx-vp9", "-deadline", "good", "-cpu-used", "5",
        "-b:v", "0", "-crf", "36", "-pix_fmt", "yuv420p", "-threads", "2",
        str(directory / "fractional-fps.webm"),
    )
    ffmpeg(
        "-f", "lavfi", "-i", "testsrc2=size=64x32:rate=1:duration=1",
        "-frames:v", "1", str(directory / "gallery-wide.png"),
    )
    ffmpeg(
        "-f", "lavfi", "-i", "testsrc2=size=96x72:rate=16:duration=1",
        "-frames:v", "8", "-c:v", "ffv1", str(directory / "unsupported.mkv"),
    )
    (directory / "broken.webm").write_bytes(b"not a video container")


if __name__ == "__main__":
    main()
