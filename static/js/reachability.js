function createAttentionView(THREE, OrbitControls, metadata, buffer, host, pointSize, onFailure, statusId) {
  const { count, anchor, blocks, kind } = metadata;
  if (!Number.isSafeInteger(count) || count <= 0 || !Array.isArray(blocks) || blocks.length === 0
      || buffer.byteLength !== metadata.bytes || !['reachability', 'attention'].includes(kind)
      || !Number.isInteger(anchor) || anchor < 0 || anchor >= count) {
    throw new Error('Invalid attention data.');
  }
  const readFrames = dataBlocks => dataBlocks.map(block => {
    if (!Number.isSafeInteger(block.count) || block.count <= 0
        || !Number.isInteger(block.anchor) || block.anchor < 0 || block.anchor >= block.count
        || !Number.isSafeInteger(block.positionsOffset) || block.positionsOffset < 0 || block.positionsOffset % 4
        || !Number.isSafeInteger(block.valuesOffset) || block.valuesOffset < 0) {
      throw new Error('Invalid attention block.');
    }
    const positions = new Float32Array(buffer, block.positionsOffset, block.count * 3);
    const values = new Uint8Array(buffer, block.valuesOffset, block.count);
    if (!positions.every(Number.isFinite)) throw new Error('Invalid token coordinates.');
    if (kind === 'reachability' && (!values.every(value => value === 0 || value === 1)
        || values.reduce((sum, value) => sum + value, 0) !== block.reachable || !values[block.anchor])) {
      throw new Error('Reachability counts do not match.');
    }
    return { positions, values };
  });
  const frames = readFrames(blocks);
  const queryFrames = new Map();
  if (metadata.queries) {
    if (!Array.isArray(metadata.queries) || metadata.queries.length === 0) {
      throw new Error('Invalid query list.');
    }
    for (const query of metadata.queries) {
      if (typeof query.id !== 'string' || !query.id || queryFrames.has(query.id)
          || !Array.isArray(query.blocks) || query.blocks.length !== blocks.length
          || query.blocks.some((block, index) => block.number !== blocks[index].number
            || block.count !== blocks[index].count || block.positionsOffset !== blocks[index].positionsOffset
            || (index === 0 && block.anchor !== query.anchor))) {
        throw new Error('Invalid query data.');
      }
      queryFrames.set(query.id, { blocks: query.blocks, frames: readFrames(query.blocks) });
    }
  }
  const positions = frames[0].positions;
  if (kind === 'attention' && (!Array.isArray(metadata.colorScale?.palette)
      || metadata.colorScale.palette.length !== 256
      || metadata.colorScale.palette.some(color => !/^#[0-9a-f]{6}$/i.test(color)))) {
    throw new Error('Invalid attention color scale.');
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch {
    const error = new Error('WebGL is unavailable.');
    error.code = 'WEBGL_UNAVAILABLE';
    throw error;
  }
  const geometries = [];
  const materials = [];
  let starTexture;
  let controls;
  let observer;
  let frame = 0;
  let disposed = false;
  let onKeyDown;
  let onContextLost;
  let resize;

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    observer?.disconnect();
    window.removeEventListener('resize', resize);
    renderer.domElement.removeEventListener('keydown', onKeyDown);
    renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
    controls?.dispose();
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    starTexture?.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  }

  try {
    renderer.setClearColor(0xffffff, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `3D ${kind === 'attention' ? 'attention weights' : 'attention reachability'}. Arrow keys pan, plus and minus zoom, and Home resets the view.`);
    canvas.setAttribute('aria-describedby', statusId);
    host.replaceChildren(canvas);

    const scene = new THREE.Scene();
    const geometry = new THREE.BufferGeometry();
    geometries.push(geometry);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const colorAttribute = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    colorAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', colorAttribute);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const center = geometry.boundingBox.getCenter(new THREE.Vector3());
    const radius = Math.max(geometry.boundingSphere.radius, 0.01);
    const camera = new THREE.PerspectiveCamera(45, 1, Math.max(0.01, radius / 10000), radius * 100);
    camera.up.set(0, 0, 1);
    const initialDirection = new THREE.Vector3(0, -1, 1.8).normalize();
    const material = new THREE.PointsMaterial({ size: pointSize, sizeAttenuation: false, vertexColors: true, toneMapped: false });
    materials.push(material);
    const cloud = new THREE.Points(geometry, material);
    scene.add(cloud);
    const stageGeometries = new Map([[blocks[0].positionsOffset, geometry]]);

    const starCanvas = document.createElement('canvas');
    starCanvas.width = starCanvas.height = 128;
    const context = starCanvas.getContext('2d');
    context.beginPath();
    for (let i = 0; i < 10; i += 1) {
      const angle = -Math.PI / 2 + i * Math.PI / 5;
      const r = i % 2 === 0 ? 57 : 24;
      const x = 64 + r * Math.cos(angle);
      const y = 64 + r * Math.sin(angle);
      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    context.fillStyle = metadata.colors.anchor;
    context.fill();
    context.strokeStyle = '#222';
    context.lineWidth = 3;
    context.stroke();
    starTexture = new THREE.CanvasTexture(starCanvas);
    starTexture.colorSpace = THREE.SRGBColorSpace;
    const anchorGeometry = new THREE.BufferGeometry();
    geometries.push(anchorGeometry);
    anchorGeometry.setAttribute('position', new THREE.BufferAttribute(positions.slice(anchor * 3, anchor * 3 + 3), 3));
    const anchorMaterial = new THREE.PointsMaterial({ size: 20, sizeAttenuation: false, map: starTexture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    materials.push(anchorMaterial);
    const marker = new THREE.Points(anchorGeometry, anchorMaterial);
    marker.renderOrder = 1;
    scene.add(marker);

    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.minDistance = radius / 1000;
    controls.maxDistance = radius * 20;
    controls.target.copy(center);
    controls.listenToKeyEvents(canvas);

    function render() {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (disposed) return;
        try {
          renderer.render(scene, camera);
        } catch (error) {
          onFailure(error);
        }
      });
    }

    resize = () => {
      if (disposed) return;
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };

    function setView(direction) {
      const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
      const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
      const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.05;
      camera.position.copy(center).addScaledVector(direction, distance);
      controls.target.copy(center);
      camera.lookAt(center);
      controls.update();
      render();
    }

    const reset = () => setView(initialDirection);
    const top = () => setView(new THREE.Vector3(0, -0.0001, 1).normalize());
    const palette = (kind === 'attention' ? metadata.colorScale.palette
      : [metadata.colors.unreachable, metadata.colors.reachable]).map(color => new THREE.Color(color));
    function setBlock(index, queryId) {
      if (disposed || !Number.isInteger(index) || index < 0 || index >= blocks.length) return;
      const query = queryFrames.get(queryId);
      const block = (query?.blocks || blocks)[index];
      const data = (query?.frames || frames)[index];
      let current = stageGeometries.get(block.positionsOffset);
      if (!current) {
        current = new THREE.BufferGeometry();
        geometries.push(current);
        current.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
        const colors = new THREE.BufferAttribute(new Float32Array(block.count * 3), 3);
        colors.setUsage(THREE.DynamicDrawUsage);
        current.setAttribute('color', colors);
        current.computeBoundingSphere();
        stageGeometries.set(block.positionsOffset, current);
      }
      cloud.geometry = current;
      const colors = current.getAttribute('color');
      for (let i = 0; i < block.count; i += 1) {
        const color = palette[data.values[i]];
        colors.setXYZ(i, color.r, color.g, color.b);
      }
      colors.needsUpdate = true;
      const anchorPosition = anchorGeometry.getAttribute('position');
      anchorPosition.array.set(data.positions.subarray(block.anchor * 3, block.anchor * 3 + 3));
      anchorPosition.needsUpdate = true;
      anchorGeometry.computeBoundingSphere();
      render();
    }

    controls.addEventListener('change', render);
    onKeyDown = (event) => {
      if (event.key === 'Home') {
        event.preventDefault();
        reset();
      } else if (['+', '=', '-', '−'].includes(event.key)) {
        event.preventDefault();
        const scale = event.key === '+' || event.key === '=' ? 0.85 : 1 / 0.85;
        const offset = camera.position.clone().sub(controls.target).multiplyScalar(scale);
        offset.clampLength(controls.minDistance, controls.maxDistance);
        camera.position.copy(controls.target).add(offset);
        controls.update();
      }
    };
    onContextLost = (event) => {
      event.preventDefault();
      if (disposed) return;
      const error = new Error('WebGL context was lost.');
      error.code = 'WEBGL_UNAVAILABLE';
      onFailure(error);
    };
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('webglcontextlost', onContextLost);
    resize();
    reset();
    observer = new ResizeObserver(resize);
    observer.observe(host);
    window.addEventListener('resize', resize);
    return {
      dispose,
      top,
      setBlock,
      setPointSize(value) {
        material.size = value;
        render();
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

function setupAttentionViewer(prefix, manifestName) {
  const dialog = document.getElementById(`${prefix}-dialog`);
  const trigger = document.querySelector(`[data-${prefix}-open]`);
  if (!dialog || !trigger) return;
  const host = dialog.querySelector('.reachability-viewport');
  const controls = dialog.querySelector('fieldset');
  const status = dialog.querySelector(`#${prefix}-status`);
  const sceneSelect = dialog.querySelector(`#${prefix}-scene`);
  const querySelect = dialog.querySelector(`#${prefix}-query`);
  const select = dialog.querySelector(`#${prefix}-block`);
  const previous = dialog.querySelector(`[data-${prefix}-previous]`);
  const next = dialog.querySelector(`[data-${prefix}-next]`);
  const slider = dialog.querySelector(`#${prefix}-size`);
  const output = dialog.querySelector('output');
  const base = new URL('../pointclouds/', import.meta.url);
  let request;
  let viewer;
  let metadata;
  let modules;
  let sequence = 0;

  function release() {
    sequence += 1;
    request?.abort();
    request = undefined;
    viewer?.dispose();
    viewer = undefined;
    controls.disabled = true;
    host.hidden = true;
    host.setAttribute('aria-busy', 'false');
    host.replaceChildren();
  }

  function failed(error, token) {
    if (token !== sequence || !dialog.open) return;
    console.error(`[MixPT 3D: ${prefix}]`, error);
    release();
    status.textContent = error.code === 'WEBGL_UNAVAILABLE'
      ? 'The 3D view requires WebGL 2. The PNG figures remain available on the page.'
      : 'The 3D view could not be loaded. Close this window and try again. The PNG figures remain available on the page.';
  }

  function updateBlock() {
    if (!viewer) return;
    const index = Number(select.value);
    const query = metadata.queries?.find(query => query.id === querySelect?.value);
    const block = (query?.blocks || metadata.blocks)[index];
    viewer.setBlock(index, query?.id);
    previous.disabled = index === 0;
    next.disabled = index === metadata.blocks.length - 1;
    if (metadata.kind === 'attention') {
      status.textContent = `Attention Block ${block.number}${query ? ` · ${query.label}` : ''}: relative attention weights over ${block.count.toLocaleString('en-US')} tokens for the selected query.`;
    } else {
      const percent = (100 * block.reachable / block.count).toFixed(1);
      status.textContent = `Attention Block ${block.number} · ${block.order}${query ? ` · ${query.label}` : ''}: ${block.reachable.toLocaleString('en-US')} of ${block.count.toLocaleString('en-US')} tokens reachable (${percent}%).`;
    }
  }

  async function loadScene(sceneId, blockNumber = 1, queryId) {
    release();
    const token = sequence;
    request = new AbortController();
    const signal = request.signal;
    status.textContent = 'Loading point cloud…';
    host.setAttribute('aria-busy', 'true');
    try {
      if (!modules) {
        modules = Promise.all([import('three'), import('three/addons/controls/OrbitControls.js')]).catch(error => {
          modules = undefined;
          throw error;
        });
      }
      const loadData = async () => {
        const response = await fetch(new URL(manifestName, base), { signal, cache: 'no-cache' });
        if (!response.ok) throw new Error('Attention metadata is unavailable.');
        const scenes = await response.json();
        if (!Array.isArray(scenes.scenes) || scenes.scenes.length === 0
            || scenes.scenes.some(scene => typeof scene.id !== 'string' || !scene.id)
            || new Set(scenes.scenes.map(scene => scene.id)).size !== scenes.scenes.length) {
          throw new Error('Invalid scene list.');
        }
        const id = sceneId || scenes.defaultScene || scenes.scenes[0].id;
        const data = scenes.scenes.find(scene => scene.id === id);
        if (!data) throw new Error('This scene is unavailable.');
        const file = new URL(data.file, base);
        if (!file.href.startsWith(base.href)) throw new Error('Invalid point cloud path.');
        file.searchParams.set('v', data.sha256);
        const binary = await fetch(file, { signal });
        if (!binary.ok) throw new Error('Attention data is unavailable.');
        return [scenes, data, await binary.arrayBuffer()];
      };
      const [[THREE, { OrbitControls }], [scenes, data, buffer]] = await Promise.all([modules, loadData()]);
      if (token !== sequence || !dialog.open) return;
      metadata = data;
      host.hidden = false;
      viewer = createAttentionView(THREE, OrbitControls, data, buffer, host, Number(slider.value), error => failed(error, token), status.id);
      sceneSelect.replaceChildren(...scenes.scenes.map(scene => new Option(scene.label, scene.id)));
      sceneSelect.value = data.id;
      sceneSelect.title = data.label;
      if (querySelect) {
        const queries = data.queries || [];
        querySelect.closest('[data-query-control]').hidden = queries.length < 2;
        querySelect.replaceChildren(...queries.map(query => new Option(query.label, query.id)));
        querySelect.value = queries.some(query => query.id === queryId) ? queryId : data.defaultQuery || queries[0]?.id || '';
      }
      select.replaceChildren(...data.blocks.map((block, index) => new Option(`${block.number}${block.order ? ` · ${block.order}` : ''}`, String(index))));
      select.value = String(Math.max(0, data.blocks.findIndex(block => block.number === blockNumber)));
      if (data.kind === 'attention') {
        const scale = data.colorScale;
        dialog.querySelector('.attention-colorbar-gradient').style.background = `linear-gradient(to right, ${scale.palette.join(', ')})`;
        dialog.querySelector('.attention-colorbar-ticks').replaceChildren(...scale.ticks.map(value => {
          const tick = document.createElement('span');
          tick.textContent = String(value);
          tick.style.left = `${100 * Math.log(value / scale.min) / Math.log(scale.max / scale.min)}%`;
          return tick;
        }));
      }
      controls.disabled = false;
      host.setAttribute('aria-busy', 'false');
      updateBlock();
    } catch (error) {
      if (error.name !== 'AbortError') failed(error, token);
    }
  }

  trigger.addEventListener('click', () => {
    if (typeof dialog.showModal !== 'function') {
      trigger.textContent = '3D requires a current browser';
      trigger.disabled = true;
      return;
    }
    dialog.showModal();
    loadScene(sceneSelect.value, 1, querySelect?.value);
  });

  sceneSelect.addEventListener('change', () => {
    const blockNumber = metadata?.blocks[Number(select.value)]?.number || 1;
    loadScene(sceneSelect.value, blockNumber, querySelect?.value);
  });

  select.addEventListener('change', updateBlock);
  querySelect?.addEventListener('change', updateBlock);
  function stepBlock(direction) {
    if (!viewer) return;
    const index = Number(select.value) + direction;
    if (index < 0 || index >= metadata.blocks.length) return;
    select.value = String(index);
    updateBlock();
  }
  previous.addEventListener('click', () => stepBlock(-1));
  next.addEventListener('click', () => stepBlock(1));
  slider.addEventListener('input', () => {
    const value = Number(slider.value);
    output.value = `${value} px`;
    slider.setAttribute('aria-valuetext', `${value} pixels`);
    viewer?.setPointSize(value);
  });
  dialog.querySelector(`[data-${prefix}-top]`).addEventListener('click', () => viewer?.top());
  dialog.querySelector(`[data-${prefix}-close]`).addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    release();
    trigger.focus({ preventScroll: true });
  });
}

export function setupReachabilityViewer() {
  setupAttentionViewer('reachability', 'reachability.json');
  setupAttentionViewer('volt', 'volt-attention.json');
}
