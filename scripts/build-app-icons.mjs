import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import { readFile, mkdir, copyFile } from 'node:fs/promises'
const source = await readFile(new URL('../src/app/icon.svg', import.meta.url))
const output = new URL('../public/icons/', import.meta.url)
await mkdir(output, { recursive: true })
for (const size of [192, 512]) {
  await sharp(source).resize(size, size).png().toFile(fileURLToPath(new URL(`unconference-${size}.png`, output)))
  const mark = await sharp(source).resize(Math.round(size * .72)).png().toBuffer()
  await sharp({ create: { width: size, height: size, channels: 4, background: '#246653' } })
    .composite([{ input: mark, gravity: 'centre' }]).png().toFile(fileURLToPath(new URL(`unconference-maskable-${size}.png`, output)))
}
await sharp(source).resize(180, 180).png().toFile(fileURLToPath(new URL('unconference-apple.png', output)))

// Older installed manifests still request these paths while their metadata refreshes.
for (const size of [192, 512]) {
  await copyFile(new URL(`unconference-${size}.png`, output), new URL(`icon-${size}.png`, output))
  await copyFile(new URL(`unconference-maskable-${size}.png`, output), new URL(`maskable-${size}.png`, output))
}
await copyFile(new URL('unconference-apple.png', output), new URL('apple-touch-icon.png', output))
