## Remote Booth 1.0.1

**Docker image:** `ghcr.io/schnubbirunkel/remote-booth:1.0.1` (amd64, arm64)

### Bildschirmübertragung / Screen sharing
- Bildschirm wird jetzt mit **30 fps** übertragen (Energiesparmodus: 15 fps), mit höherer Bitrate (bis 6 Mbit/s) für scharfen Text auch bei Bewegung.
  Screen sharing now runs at **30 fps** (power-saving mode: 15 fps) with a higher bitrate (up to 6 Mbps) for sharp text even with motion.
- **H.264 mit Hardware-Kodierung** wird bevorzugt, wo Grafikkarte/Browser es unterstützen.
  **H.264 with hardware encoding** is preferred where the GPU/browser supports it.
- Neue Anzeige auf der eigenen Bildschirm-Kachel: Auflösung, tatsächliche fps, Codec und ob in Hardware oder Software kodiert wird.
  New badge on your own screen tile: resolution, actual fps, codec and whether hardware or software encoding is used.

### Veröffentlichung / Publishing
- Neue Versionen werden automatisch veröffentlicht: Version in `package.json` erhöhen und auf `main` pushen – Image, App Store und GitHub-Release entstehen automatisch.
  New versions are published automatically: raise the version in `package.json` and push to `main` – image, app store and GitHub release are created automatically.
