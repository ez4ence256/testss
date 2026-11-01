// Page minimale ouverte par le QR code (`/?phone=CODE`) : photos (ou vidéo, découpée ici en images) du menu Tâches, envoyées au PC.
// Rien n'est stocké sur le téléphone (ni localStorage ni état de l'appli) ; les photos ne font que transiter par le relais.
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { tr } from "../lib/i18n";
import { downscaleSize, pickFrames, sharpness, VIDEO_MAX_FRAMES, VIDEO_STEP, type FrameSample } from "../lib/phoneCapture";

interface Photo {
  id: string;
  url: string; // miniature locale (URL d'objet)
}

/** Réduit la photo (côté long ≤ 1600 px) et l'encode en JPEG 0,85 ; l'orientation EXIF est appliquée. */
async function shrink(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { width, height } = downscaleSize(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("encode");
  return blob;
}

const toJpeg = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", 0.85));

/**
 * Découpe une vidéo de la liste qui défile en images nettes et différentes (voir pickFrames) ; la vidéo
 * reste sur le téléphone, seules ces images partent au PC.
 */
async function videoFrames(file: Blob, max: number, onProgress: (p: number) => void): Promise<Blob[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error("encode"));
    });
    // iOS n'affiche pas d'image tant que la vidéo n'a pas démarré
    await video.play().catch(() => {});
    video.pause();
    const seek = (t: number) =>
      new Promise((resolve) => {
        video.onseeked = resolve;
        video.currentTime = t;
      });
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("encode");
    // netteté sur 320 px de large, comparaison sur 64 px
    const big = document.createElement("canvas");
    big.width = 320;
    big.height = Math.max(1, Math.round((320 * video.videoHeight) / video.videoWidth));
    const small = document.createElement("canvas");
    small.width = 64;
    small.height = Math.max(1, Math.round((64 * video.videoHeight) / video.videoWidth));
    const grayOf = (c: HTMLCanvasElement) => {
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(video, 0, 0, c.width, c.height);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const g = new Uint8ClampedArray(c.width * c.height);
      for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
      return g;
    };
    const samples: FrameSample[] = [];
    for (let t = VIDEO_STEP / 2; t < duration; t += VIDEO_STEP) {
      await seek(t);
      samples.push({ t, sharp: sharpness(grayOf(big), big.width, big.height), gray: grayOf(small) });
      onProgress(t / duration);
    }
    const { width, height } = downscaleSize(video.videoWidth, video.videoHeight);
    const full = document.createElement("canvas");
    full.width = width;
    full.height = height;
    const frames: Blob[] = [];
    for (const t of pickFrames(samples, duration, max)) {
      await seek(t);
      full.getContext("2d")!.drawImage(video, 0, 0, width, height);
      frames.push(await toJpeg(full));
    }
    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

const HTTP_ERRORS: Record<number, [string, string]> = {
  404: ["Session expirée : rouvre le QR code sur le PC.", "Session expired: open the QR code on the PC again."],
  409: ["Trop de photos (30 au plus) ou déjà envoyé.", "Too many photos (30 at most) or already sent."],
  413: ["Photo trop lourde.", "Photo too large."],
  429: ["Trop de requêtes, réessaie dans une minute.", "Too many requests, try again in a minute."],
  503: ["Serveur saturé, réessaie dans une minute.", "Server busy, try again in a minute."],
};
const httpError = (status: number) => tr(...(HTTP_ERRORS[status] ?? ["Envoi impossible.", "Could not send."]));

export function PhonePage({ code }: { code: string }) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState<string | false>(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const api = `/api/phone/${code}`;

  useEffect(() => {
    document.title = tr("Photos des quêtes", "Quest photos");
  }, []);

  const upload = async (blob: Blob) => {
    const res = await fetch(`${api}/photo`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
    if (!res.ok) throw new Error(httpError(res.status));
    const { id } = (await res.json()) as { id: string };
    setPhotos((p) => [...p, { id, url: URL.createObjectURL(blob) }]);
  };

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // permet de reprendre la même photo / une nouvelle tout de suite
    if (!file) return;
    const isVideo = file.type.startsWith("video/");
    setBusy(tr("Envoi…", "Sending…"));
    setError(null);
    try {
      if (isVideo) {
        const room = Math.min(VIDEO_MAX_FRAMES, 30 - photos.length);
        const frames = await videoFrames(file, room, (p) => setBusy(tr(`Découpage de la vidéo… ${Math.round(p * 100)} %`, `Cutting the video… ${Math.round(p * 100)}%`)));
        for (const [i, frame] of frames.entries()) {
          setBusy(tr(`Envoi ${i + 1}/${frames.length}…`, `Sending ${i + 1}/${frames.length}…`));
          await upload(frame);
        }
      } else await upload(await shrink(file));
    } catch (err) {
      const msg = (err as Error).message;
      setError(
        msg === "encode" || err instanceof TypeError || (err as Error).name === "InvalidStateError"
          ? isVideo
            ? tr("Vidéo illisible ou réseau coupé : réessaie.", "Unreadable video or network down: try again.")
            : tr("Photo illisible ou réseau coupé : réessaie.", "Unreadable photo or network down: try again.")
          : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (photo: Photo) => {
    setError(null);
    try {
      const res = await fetch(`${api}/photo/${photo.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(httpError(res.status));
      URL.revokeObjectURL(photo.url);
      setPhotos((p) => p.filter((x) => x.id !== photo.id));
    } catch (err) {
      setError(err instanceof TypeError ? tr("Réseau coupé : réessaie.", "Network down: try again.") : (err as Error).message);
    }
  };

  const send = async () => {
    setBusy(tr("Envoi…", "Sending…"));
    setError(null);
    try {
      const res = await fetch(`${api}/done`, { method: "POST" });
      if (!res.ok) throw new Error(httpError(res.status));
      setSent(true);
    } catch (err) {
      setError(err instanceof TypeError ? tr("Réseau coupé : réessaie.", "Network down: try again.") : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <main className="phone-page">
        <h1>{tr("Envoyé !", "Sent!")}</h1>
        <p>{tr("Tu peux fermer cette page.", "You can close this page.")}</p>
      </main>
    );
  }

  return (
    <main className="phone-page">
      <h1>{tr("Tarkov Quest Planner — photos des quêtes", "Tarkov Quest Planner — quest photos")}</h1>
      <p className="muted">
        {tr(
          "Photographie le menu Tâches du jeu, fais défiler la liste, recommence autant que nécessaire. Ou filme la liste en la faisant défiler lentement : la vidéo est découpée en images ici, sur le téléphone.",
          "Photograph the in-game Tasks menu, scroll the list, and repeat as needed. Or film the list while scrolling slowly: the video is cut into images here, on the phone.",
        )}
      </p>
      <div className="phone-modes">
        <button className="btn btn-primary phone-shot" disabled={!!busy} onClick={() => inputRef.current?.click()}>
          {tr("Prendre une photo", "Take a photo")}
        </button>
        <button className="btn btn-primary phone-shot" disabled={!!busy} onClick={() => videoRef.current?.click()}>
          {tr("Filmer la liste", "Film the list")}
        </button>
      </div>
      {busy && <p role="status">{busy}</p>}
      <input ref={inputRef} type="file" accept="image/*" capture="environment" hidden onChange={onPick} />
      <input ref={videoRef} type="file" accept="video/*" capture="environment" hidden onChange={onPick} />
      {error && <p className="error" role="alert">{error}</p>}
      <p role="status">{`${photos.length} photo${photos.length > 1 ? "s" : ""}`}</p>
      <ul className="phone-thumbs">
        {photos.map((p, i) => (
          <li key={p.id}>
            <img src={p.url} alt={`Photo ${i + 1}`} />
            <button className="btn btn-small" disabled={!!busy} onClick={() => void remove(p)}>
              {tr("Retirer", "Remove")}
            </button>
          </li>
        ))}
      </ul>
      <button className="btn btn-primary phone-shot" disabled={!!busy || photos.length === 0} onClick={() => void send()}>
        {tr("C'est bon, envoyer", "Done, send")}
      </button>
    </main>
  );
}
