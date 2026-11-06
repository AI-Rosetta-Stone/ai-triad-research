// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import './KeySharingDialog.css';
import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type jsQRType from 'jsqr';
import { useDialog } from '../shared/useDialog'; // t/4909

let _jsQR: typeof jsQRType | null = null;
async function loadJsQR() {
  if (!_jsQR) {
    const mod = await import('jsqr');
    _jsQR = mod.default;
  }
  return _jsQR;
}

type Mode = 'choose' | 'export' | 'import-scan' | 'import-paste';

interface KeySharingDialogProps {
  onClose: () => void;
  onKeysImported: () => void;
}

export function KeySharingDialog({ onClose, onKeysImported }: KeySharingDialogProps) {
  const [mode, setMode] = useState<Mode>('choose');
  const [passphrase, setPassphrase] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [payloadText, setPayloadText] = useState('');
  const [pasteInput, setPasteInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanIntervalRef = useRef<number | null>(null);
  const { dialogRef, titleId } = useDialog({ onCancel: onClose }); // t/4909

  const stopCamera = useCallback(() => {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    setScanning(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const handleExport = async () => {
    if (!passphrase.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.exportKeysForSharing(passphrase.trim());
      setQrDataUrl(result.dataUrl);
      setPayloadText(result.payloadText);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'key-sharing-dialog',
        level: 'error',
        message: 'Failed to export keys for sharing',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleImport = async (payloadStr: string) => {
    if (!passphrase.trim() || !payloadStr.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const payload = JSON.parse(payloadStr);
      const imported = await api.importKeysFromSharing(payload, passphrase.trim());
      setSuccess(`Imported keys: ${imported.join(', ')}`);
      onKeysImported();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'key-sharing-dialog',
        level: 'error',
        message: 'Failed to import keys from sharing payload',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes('Unsupported state') || msg.includes('unable to authenticate')
        ? 'Wrong passphrase or corrupted payload'
        : msg);
    } finally {
      setLoading(false);
    }
  };

  const startCamera = async () => {
    setError(null);
    try {
      const [stream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }),
        loadJsQR(),
      ]);
      streamRef.current = stream;
      setScanning(true);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'key-sharing-dialog',
        level: 'error',
        message: 'Failed to access camera for QR scanning',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setError('Camera not available. Use "Paste Payload" instead.');
    }
  };

  useEffect(() => {
    if (!scanning || !streamRef.current) return;
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = streamRef.current;
    video.play().catch((err) => {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'key-sharing-dialog', level: 'debug', message: 'Video autoplay blocked', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    });

    scanIntervalRef.current = window.setInterval(() => {
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (!_jsQR) return;
      const code = _jsQR(imageData.data, imageData.width, imageData.height);
      if (code?.data) {
        stopCamera();
        setPasteInput(code.data);
        setMode('import-paste');
      }
    }, 250);

    return () => {
      if (scanIntervalRef.current) {
        clearInterval(scanIntervalRef.current);
        scanIntervalRef.current = null;
      }
    };
  }, [scanning, stopCamera]);

  const handleCopyPayload = async () => {
    try {
      await api.clipboardWriteText(payloadText);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'key-sharing-dialog',
        level: 'error',
        message: 'Failed to copy payload to clipboard',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div ref={dialogRef} className="dialog settings-dialog key-sharing-dialog" role="dialog" aria-modal aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId}>Key Sharing</h3>

        {mode === 'choose' && (
          <ChoosePanel
            onExport={() => setMode('export')}
            onScan={() => { setMode('import-scan'); void startCamera(); }}
            onPaste={() => setMode('import-paste')}
          />
        )}

        {mode === 'export' && (
          <ExportPanel
            passphrase={passphrase}
            setPassphrase={setPassphrase}
            loading={loading}
            qrDataUrl={qrDataUrl}
            onExport={handleExport}
            onCopyPayload={handleCopyPayload}
          />
        )}

        {mode === 'import-scan' && (
          <>
            <p className="key-sharing-hint">
              Point your camera at the QR code displayed on the source device.
            </p>
            {scanning && (
              <div className="key-sharing-video-wrap">
                <video ref={videoRef} className="key-sharing-video" muted playsInline />
                <canvas ref={canvasRef} className="key-sharing-canvas" />
              </div>
            )}
            <button className="btn btn-sm key-sharing-full-btn" onClick={() => { stopCamera(); setMode('import-paste'); }}>
              Switch to Paste Payload
            </button>
          </>
        )}

        {mode === 'import-paste' && !success && (
          <PastePanel
            pasteInput={pasteInput}
            setPasteInput={setPasteInput}
            passphrase={passphrase}
            setPassphrase={setPassphrase}
            loading={loading}
            onImport={handleImport}
          />
        )}

        {error && <div className="settings-key-error key-sharing-message">{error}</div>}
        {success && <div className="settings-key-success key-sharing-message">{success}</div>}

        <DialogActions
          mode={mode}
          success={success}
          onBack={() => { stopCamera(); setMode('choose'); setQrDataUrl(null); setError(null); setPassphrase(''); setPasteInput(''); }}
          onCloseClick={() => { stopCamera(); onClose(); }}
        />
      </div>
    </div>
  );
}

interface ChoosePanelProps {
  onExport: () => void;
  onScan: () => void;
  onPaste: () => void;
}

function ChoosePanel({ onExport, onScan, onPaste }: ChoosePanelProps) {
  return (
    <>
      <p className="key-sharing-intro">
        Transfer API keys between devices using an encrypted QR code.
      </p>
      <div className="key-sharing-choice-row">
        <button className="btn btn-primary key-sharing-choice-btn" onClick={onExport}>
          Share Keys (QR)
        </button>
        <button className="btn key-sharing-choice-btn" onClick={onScan}>
          Scan QR
        </button>
        <button className="btn key-sharing-choice-btn" onClick={onPaste}>
          Paste Payload
        </button>
      </div>
    </>
  );
}

interface ExportPanelProps {
  passphrase: string;
  setPassphrase: (value: string) => void;
  loading: boolean;
  qrDataUrl: string | null;
  onExport: () => void;
  onCopyPayload: () => void;
}

function ExportPanel({ passphrase, setPassphrase, loading, qrDataUrl, onExport, onCopyPayload }: ExportPanelProps) {
  if (!qrDataUrl) {
    return (
      <div className="settings-key-section">
        <label className="settings-label">Encryption Passphrase</label>
        <p className="key-sharing-hint">
          Choose a passphrase to encrypt your keys. You will need this same passphrase on the target device.
        </p>
        <div className="settings-key-row">
          <input
            type="password"
            className="settings-key-input"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Enter passphrase..."
            onKeyDown={(e) => { if (e.key === 'Enter') void onExport(); }}
          />
          <button className="btn btn-primary btn-sm" onClick={onExport} disabled={!passphrase.trim() || loading}>
            {loading ? '...' : 'Generate QR'}
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="key-sharing-warning">
        Anyone who photographs this QR code can extract your API keys (with the passphrase). Do not share it publicly.
      </div>
      <div className="key-sharing-qr-wrap">
        <img src={qrDataUrl} alt="API keys QR code" className="key-sharing-qr-img" />
      </div>
      <button className="btn btn-sm key-sharing-full-btn" onClick={onCopyPayload}>
        Copy Encrypted Payload (for paste import)
      </button>
    </>
  );
}

interface PastePanelProps {
  pasteInput: string;
  setPasteInput: (value: string) => void;
  passphrase: string;
  setPassphrase: (value: string) => void;
  loading: boolean;
  onImport: (payloadStr: string) => void;
}

function PastePanel({ pasteInput, setPasteInput, passphrase, setPassphrase, loading, onImport }: PastePanelProps) {
  return (
    <>
      <div className="settings-key-section">
        <label className="settings-label">Encrypted Payload</label>
        <textarea
          className="settings-key-input key-sharing-payload-textarea"
          value={pasteInput}
          onChange={(e) => setPasteInput(e.target.value)}
          placeholder='Paste the encrypted payload JSON here...'
          rows={3}
        />
      </div>
      <div className="settings-key-section key-sharing-section-spaced">
        <label className="settings-label">Passphrase</label>
        <div className="settings-key-row">
          <input
            type="password"
            className="settings-key-input"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Enter the passphrase used during export..."
            onKeyDown={(e) => { if (e.key === 'Enter') void onImport(pasteInput); }}
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void onImport(pasteInput)}
            disabled={!passphrase.trim() || !pasteInput.trim() || loading}
          >
            {loading ? '...' : 'Import'}
          </button>
        </div>
      </div>
    </>
  );
}

interface DialogActionsProps {
  mode: Mode;
  success: string | null;
  onBack: () => void;
  onCloseClick: () => void;
}

function DialogActions({ mode, success, onBack, onCloseClick }: DialogActionsProps) {
  return (
    <div className="dialog-actions key-sharing-actions">
      {mode !== 'choose' && !success && (
        <button className="btn btn-sm" onClick={onBack}>
          Back
        </button>
      )}
      <button className="btn btn-primary" onClick={onCloseClick}>
        {success ? 'Done' : 'Close'}
      </button>
    </div>
  );
}
