import * as THREE from "three";

export function mountDrone(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(160, 160, false);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 30);
  camera.position.set(2.4, 1.7, 2.5);
  camera.lookAt(0, 0.05, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(3, 6, 2);
  scene.add(sun);

  const orange = new THREE.MeshStandardMaterial({ color: 0xc25a26, roughness: 0.45 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c2430, roughness: 0.4 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0xd7e7f2,
    roughness: 0.15,
    metalness: 0.1,
    transparent: true,
    opacity: 0.8,
  });
  const rotorMat = new THREE.MeshStandardMaterial({
    color: 0x243038,
    transparent: true,
    opacity: 0.72,
  });

  const craft = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.14, 0.24), orange);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.16), dark);
  deck.position.y = 0.1;
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), glass);
  canopy.scale.set(1, 0.7, 1.3);
  canopy.position.set(0, 0.16, 0.02);
  craft.add(body, deck, canopy);

  const rotors = [];
  [[0.48, 0.48], [0.48, -0.48], [-0.48, 0.48], [-0.48, -0.48]].forEach(([x, z], index) => {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.035, 0.045), dark);
    arm.position.set(x * 0.5, 0.02, z * 0.5);
    arm.rotation.y = -Math.atan2(z, x);
    craft.add(arm);

    const rotor = new THREE.Group();
    rotor.position.set(x, 0.1, z);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.2, 20), rotorMat);
    disc.rotation.x = -Math.PI / 2;
    const bladeA = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.012, 0.045), dark);
    const bladeB = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.012, 0.38), dark);
    rotor.add(disc, bladeA, bladeB);
    craft.add(rotor);
    rotors.push({ rotor, speed: index % 2 === 0 ? 0.55 : -0.55 });
  });

  scene.add(craft);
  let frame = 0;
  const draw = () => {
    frame = requestAnimationFrame(draw);
    rotors.forEach(({ rotor, speed }) => {
      rotor.rotation.y += speed;
    });
    craft.rotation.y += 0.006;
    renderer.render(scene, camera);
  };
  draw();

  return () => {
    cancelAnimationFrame(frame);
    renderer.dispose();
  };
}
