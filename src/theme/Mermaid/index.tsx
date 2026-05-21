import React, { useEffect, useRef, useState } from 'react';
import ErrorBoundary from '@docusaurus/ErrorBoundary';
import { ErrorBoundaryErrorMessageFallback } from '@docusaurus/theme-common';
import {
  MermaidContainerClassName,
  useMermaidRenderResult,
} from '@docusaurus/theme-mermaid/client';
import styles from './styles.module.css';

const ZOOM_STEP = 0.2;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

function MermaidRenderResult({ renderResult }: { renderResult: any }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const div = containerRef.current;
    if (div) {
      renderResult.bindFunctions?.(div);
    }
  }, [renderResult]);

  const handleZoomIn = () => {
    setZoom((current) => Math.min(MAX_ZOOM, Number((current + ZOOM_STEP).toFixed(2))));
  };

  const handleZoomOut = () => {
    setZoom((current) => Math.max(MIN_ZOOM, Number((current - ZOOM_STEP).toFixed(2))));
  };

  const handleReset = () => setZoom(1);

  return (
    <div className={styles.wrapper}>
      <div className={styles.toolbar}>
        <button type="button" onClick={handleZoomOut} className={styles.button}>
          −
        </button>
        <button type="button" onClick={handleReset} className={styles.button}>
          Reset
        </button>
        <button type="button" onClick={handleZoomIn} className={styles.button}>
          +
        </button>
        <span className={styles.label}>{(zoom * 100).toFixed(0)}%</span>
      </div>
      <div className={styles.preview}>
        <div
          ref={containerRef}
          className={`${MermaidContainerClassName} ${styles.container}`}
          style={{
            transform: `scale(1)`,
            transformOrigin: 'top left',
            width: `${zoom * 100}%`,
          }}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: renderResult.svg }}
        />
      </div>
    </div>
  );
}

function MermaidRenderer({ value }: { value: string }) {
  const renderResult = useMermaidRenderResult({ text: value });
  if (renderResult === null) {
    return null;
  }
  return <MermaidRenderResult renderResult={renderResult} />;
}

export default function Mermaid(props: { value: string }) {
  return (
    <ErrorBoundary
      fallback={(params) => <ErrorBoundaryErrorMessageFallback {...params} />}>
      <MermaidRenderer {...props} />
    </ErrorBoundary>
  );
}
