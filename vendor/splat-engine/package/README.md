# @viggle/splat-engine

Minimal Gaussian Splat character engine. Load `.vsplat` characters, play MetaHuman GLB skeletal animations with crossfade blending, load `.ply`/`.spz` environment splats, render with PlayCanvas.

## Install

```bash
npm install @viggle/splat-engine playcanvas@2.18.0
```


This engine reaches into PlayCanvas well past its
  documented surface - the splat pipeline, the sorter and the shader chunks all
  depend on internals that carry no compatibility promise across minor versions.
  Using other PlayCanvas versions may cause issues.


## Quick Start

Get the character .vsplat file and glb animations from https://viggle.ai/pinoc/app/

```typescript
import {
  Scene,
  Character,
  Animation,
  Environment,
  OrbitControls,
  Grid,
  SkyDome,
} from '@viggle/splat-engine';

// 1. Create scene
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const scene = await Scene.create(canvas, { fov: 45 });
scene.start();

// 2. Orbit camera + sky + grid + environment splat (optional)
const controls = new OrbitControls({
  distance: 4,
  pitch: 15,
  target: { x: 0, y: 0.8, z: 0 },
});
controls.attach({ canvas, cameraEntity: scene.cameraEntity });
scene.app.on('update', () => controls.update());
SkyDome.create(scene, { topColor: '#c2f0ff', bottomColor: '#ffffff' });
Grid.create(scene);
await Environment.load(scene, '/assets/room.spz');

// 3. Load character
const character = await Character.load(scene, '/assets/character.vsplat');

// 4. Load animations (fetch + parse + register in one call)
await Promise.all([
  Animation.loadGlb(scene, '/assets/idle.glb', 'idle'),
  Animation.loadGlb(scene, '/assets/run.glb', 'run'),
]);

// 5. Play / crossfade
character.playAnimation('idle', { loop: true });
character.crossfadeTo('run', { duration: 0.3, loop: true });
```

### FAQ:
If you want depth-correct mixing of GLB models with splats, set `depth: true` on `Scene.create` - otherwise PC standard meshes paint in submission order.

The engine does not include physics, does not ship Ammo, and has no opinion about gravity or simulation step. It can register PlayCanvas's Ammo-backed `RigidBodyComponentSystem` + `CollisionComponentSystem` if you ask for them.

---

## Licence

MIT. See [LICENSE](./LICENSE).