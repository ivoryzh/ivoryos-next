"use client";

import { useState } from 'react';
import { Server } from 'lucide-react';

/**
 * A device's picture (set on the Devices page), or a plain icon when it has none. `version` is
 * the device's `image_version`: it keys the URL, so the image route can be cached indefinitely and
 * a new picture is still fetched the moment it changes.
 */
export default function DeviceAvatar({
  id, version, size = 20, className = '', title,
}: { id: string; version?: string | null; size?: number; className?: string; title?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const style = { width: size, height: size };
  const shape = `shrink-0 rounded-md overflow-hidden ${className}`;
  if (!version || broken === version) {
    return (
      <span className={`${shape} inline-flex items-center justify-center bg-gray-100 text-gray-400 dark:bg-white/5 dark:text-gray-500`} style={style} title={title}>
        <Server style={{ width: size * 0.6, height: size * 0.6 }} />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a same-origin API image, not a static asset
    <img
      src={`/api/devices/${encodeURIComponent(id)}/image?v=${encodeURIComponent(version)}`}
      alt="" title={title}
      className={`${shape} object-cover`} style={style}
      onError={() => setBroken(version)}
    />
  );
}

/** Scale a picked file down to a thumbnail and encode it, so an 8 MB phone photo uploads as ~30 KB. */
export async function toThumbnail(file: File, max = 256): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That file is not an image this browser can read.'));
      el.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    // WebP where the browser can encode it (smaller); PNG-only encoders fall back automatically.
    const webp = canvas.toDataURL('image/webp', 0.85);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
