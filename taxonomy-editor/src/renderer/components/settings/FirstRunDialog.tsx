// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useDialog } from '../shared/useDialog'; // t/4901

const isWeb = import.meta.env.VITE_TARGET === 'web';

interface FirstRunDialogProps {
  dataRoot: string;
  onComplete: () => void;
  onSkip: () => void;
}

export function FirstRunDialog({ dataRoot, onComplete, onSkip }: FirstRunDialogProps) {
  const [status, setStatus] = useState<'prompt' | 'downloading' | 'done' | 'error'>('prompt');
  const [message, setMessage] = useState('');
  const [downloadPath, setDownloadPath] = useState(dataRoot || '/data');
  const [locatePath, setLocatePath] = useState(dataRoot || '/data');
  // t/4901: Esc mirrors the "Skip for Now"/"Skip" buttons already in this flow — disabled while
  // a download is in flight, the same guard those buttons don't need since this dialog has no
  // overlay-click-to-close either (a mandatory first-run flow, not casually dismissable).
  const { dialogRef, titleId } = useDialog({ onCancel: onSkip, closeOnEscape: status !== 'downloading' });

  const handleLocateData = async () => {
    if (isWeb) {
      // In web/container mode, use the typed path
      if (!locatePath.trim()) return;
      try {
        await api.setDataRoot(locatePath.trim());
        // Verify data is actually there after setting root
        const available = await api.isDataAvailable();
        if (available) {
          onComplete();
        } else {
          setMessage(`No taxonomy data found at "${locatePath}". Check the path and try again.`);
          setStatus('error');
        }
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'first-run-dialog',
          level: 'error',
          message: 'Failed to locate data directory',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        setMessage(String(err));
        setStatus('error');
      }
    } else {
      // Electron mode: native file dialog
      const result = await api.pickDirectory(dataRoot);
      if (!result.cancelled && result.path) {
        await api.setDataRoot(result.path);
        onComplete();
      }
    }
  };

  const handleBrowseDownloadPath = async () => {
    if (isWeb) return; // no native dialog in web mode
    const result = await api.pickDirectory(downloadPath);
    if (!result.cancelled && result.path) {
      setDownloadPath(result.path);
    }
  };

  const handleDownload = async () => {
    setStatus('downloading');
    setMessage('Cloning research data from GitHub...');
    try {
      const result = await api.cloneDataRepo(downloadPath);
      if (result.success) {
        setStatus('done');
        setMessage('Data downloaded successfully!');
        await api.setDataRoot(downloadPath);
        setTimeout(onComplete, 1500);
      } else {
        setStatus('error');
        setMessage(result.message);
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'first-run-dialog',
        level: 'error',
        message: 'Failed to download data repo',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setStatus('error');
      setMessage(String(err));
    }
  };

  return (
    <div className="dialog-overlay">
      <div ref={dialogRef} className="dialog first-run-dialog" role="dialog" aria-modal aria-labelledby={titleId}>
        <div className="first-run-icon">&#128218;</div>
        <h2 id={titleId}>Welcome to AI Triad</h2>

        {status === 'prompt' && (
          <>
            <p className="first-run-desc">
              AI Rosetta Stone needs research data to operate. This includes taxonomy definitions,
              source documents, summaries, and conflict analyses (~410 MB).
            </p>

            <div className="first-run-section">
              <p className="first-run-section-label">Already have the data?</p>
              {isWeb ? (
                <div className="first-run-path">
                  <span className="first-run-path-label">Path to data directory:</span>
                  <div className="first-run-path-row">
                    <input
                      type="text"
                      className="first-run-path-input"
                      value={locatePath}
                      onChange={(e) => setLocatePath(e.target.value)}
                      placeholder="/path/to/ai-triad-data"
                      onKeyDown={(e) => e.key === 'Enter' && handleLocateData()}
                    />
                  </div>
                </div>
              ) : null}
              <button className="btn btn-primary first-run-btn" onClick={handleLocateData}>
                {isWeb ? 'Use This Path' : 'Locate Existing Data...'}
              </button>
            </div>

            <div className="first-run-divider">
              <span>or</span>
            </div>

            <div className="first-run-section">
              <p className="first-run-section-label">Download from GitHub</p>
              <div className="first-run-path">
                <span className="first-run-path-label">Download to:</span>
                <div className="first-run-path-row">
                  {isWeb ? (
                    <input
                      type="text"
                      className="first-run-path-input"
                      value={downloadPath}
                      onChange={(e) => setDownloadPath(e.target.value)}
                    />
                  ) : (
                    <>
                      <code className="first-run-path-value">{downloadPath}</code>
                      <button
                        className="btn btn-sm first-run-browse-btn"
                        onClick={handleBrowseDownloadPath}
                        title="Choose a different directory"
                      >
                        Browse...
                      </button>
                    </>
                  )}
                </div>
              </div>
              <button className="btn first-run-btn" onClick={handleDownload}>
                Download Data
              </button>
            </div>

            <div className="first-run-actions">
              <button className="btn first-run-btn first-run-btn-skip" onClick={onSkip}>
                Skip for Now
              </button>
            </div>
            <p className="first-run-hint">
              You can configure the data location later from Settings or by running{' '}
              <code>Install-AITriadData</code> in PowerShell.
            </p>
          </>
        )}

        {status === 'downloading' && (
          <div className="first-run-progress">
            <div className="first-run-spinner" />
            <p>{message}</p>
            <p className="first-run-hint">This may take a few minutes depending on your connection.</p>
          </div>
        )}

        {status === 'done' && (
          <div className="first-run-progress">
            <div className="first-run-check">&#10003;</div>
            <p>{message}</p>
          </div>
        )}

        {status === 'error' && (
          <div className="first-run-progress">
            <p className="first-run-error">{message}</p>
            <div className="first-run-actions">
              <button className="btn btn-primary first-run-btn" onClick={() => setStatus('prompt')}>
                Back
              </button>
              <button className="btn first-run-btn" onClick={onSkip}>
                Skip
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
