// Runs before the module graph, so module/download failures remain visible.
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var modes = ['auto', 'raster', 'webgl'];
  var key = 'splatFighter.renderer.v8:' + location.pathname;
  var mode = 'auto';
  try { mode = sessionStorage.getItem(key) || mode; } catch (_) {}
  if (params.has('webgl')) mode = 'webgl';
  if (modes.indexOf(params.get('renderer')) !== -1) mode = params.get('renderer');
  if (modes.indexOf(mode) === -1) mode = 'auto';
  var changing = false, timer, lastProgress = Date.now(), currentDevice;
  function text(message) {
    var overlay = document.getElementById('loading');
    if (overlay) overlay.classList.remove('hidden');
    var label = document.getElementById('loadText');
    if (label) label.textContent = message;
  }
  function switchMode(next) {
    if (changing) return;
    if (next === 'compat') next = mode === 'auto' ? 'raster' : 'webgl';
    changing = true;
    try { sessionStorage.setItem(key, next); } catch (_) {}
    // The URL carries recovery even when browser storage is blocked.
    var url = new URL(location.href);
    url.searchParams.delete('webgl');
    url.searchParams.set('renderer', next);
    location.replace(url.href);
  }
  function fatal(error) {
    clearInterval(timer);
    var message = error && error.message ? error.message : String(error);
    text('游戏无法启动：' + message);
    var retry = document.getElementById('retryBoot');
    if (!retry) {
      retry = document.createElement('button');
      retry.id = 'retryBoot'; retry.className = 'btn'; retry.textContent = '重新加载';
      retry.addEventListener('click', function () { location.reload(); });
      document.getElementById('loading').appendChild(retry);
    }
    console.error('[Splat Fighter]', error);
  }
  function recover(error) {
    if (changing) return true;
    var next = mode === 'auto' ? 'raster' : mode === 'raster' ? 'webgl' : null;
    if (!next) { fatal(new Error('图形渲染失败。请确认浏览器已启用图形加速并更新显卡驱动。' + (error && error.message ? ' ' + error.message : ''))); return false; }
    text('正在恢复画面并切换兼容模式…');
    console.warn('[Splat Fighter] rendering fallback', mode, next, error && error.message ? error.message : String(error));
    switchMode(next);
    return true;
  }
  function watch(scene) {
    currentDevice = scene.graphicsDevice;
    if (!currentDevice.isWebGPU && !currentDevice.isWebGL2) {
      throw new Error('浏览器未提供可用的 WebGPU 或 WebGL2。请启用图形加速并更新浏览器。');
    }
    if (currentDevice.isWebGL2) mode = 'webgl';
    currentDevice.on('devicelost', function () { recover(new Error('图形设备连接中断')); });
    if (currentDevice.wgpu) {
      currentDevice.wgpu.addEventListener('uncapturederror', function (event) {
        event.preventDefault();
        recover(event.error);
      });
    }
  }
  window.splatCompatibility = {
    mode: mode, watch: watch, recover: recover, fatal: fatal,
    progress: function () { lastProgress = Date.now(); },
    ready: function () { clearInterval(timer); },
    bootFailed: function (error, asset) {
      // A missing/download-failed asset is not a GPU failure.
      if (!asset && /webgpu|webgl|gpu|graphics|shader|render|context|device/i.test(String(error))) recover(error);
      else fatal(error);
    }
  };
  document.querySelectorAll('[data-renderer]').forEach(function (button) {
    button.addEventListener('click', function () { switchMode(button.dataset.renderer); });
  });
  window.addEventListener('error', function (event) {
    // Ignore unrelated browser extension errors.
    if (!event.filename || !event.filename.startsWith(location.origin + location.pathname.replace(/[^/]*$/, ''))) return;
    if (/gpu|graphics|shader|render|context|device/i.test(event.message)) recover(event.error || new Error(event.message));
    else fatal(event.error || new Error(event.message));
  });
  document.addEventListener('visibilitychange', function () { lastProgress = Date.now(); });
  timer = setInterval(function () {
    // Do not mistake a throttled background tab or a slow asset download for a GPU hang.
    var label = document.getElementById('loadText');
    if (document.hidden || Date.now() - lastProgress < 30000 || !label) return;
    if (label.textContent.indexOf('正在启动') !== -1) recover(new Error('图形初始化超时'));
  }, 2000);
  if (location.protocol === 'file:') {
    fatal(new Error('请双击 start.bat，通过本地网址打开游戏。'));
    return;
  }
  if (!window.HTMLScriptElement || !HTMLScriptElement.supports || !HTMLScriptElement.supports('importmap')) {
    fatal(new Error('当前浏览器版本过旧，请更新到支持模块映射的 Chrome、Edge、Firefox 或 Safari。'));
    return;
  }
  // Dynamic import makes module HTTP errors and syntax failures catchable.
  import('./main.js?v=8').catch(fatal);
})();
