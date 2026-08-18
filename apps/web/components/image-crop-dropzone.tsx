"use client";

import { ImageIcon, Minus, Plus, RotateCcw, Upload, X } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";

export type ImageCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type ImageSize = { naturalWidth: number; naturalHeight: number };
type DisplayedImage = { scale: number; width: number; height: number };
type ImageRect = Rect & { scale: number };
type TransformState = { scale: number; positionX: number; positionY: number };
type DragHandle = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";
type CropDragState =
  | {
      type: "move";
      pointerId: number;
      startPointer: Point;
      startCrop: Rect;
    }
  | {
      type: "resize";
      pointerId: number;
      handle: DragHandle;
      startPointer: Point;
      startCrop: Rect;
    };

type ImageCropDropzoneProps = {
  file: File | null;
  preview: string | null;
  disabled?: boolean;
  onFileSelected: (file: File) => void;
  onRemove: () => void;
  onCropChange: (crop: ImageCrop) => void;
  onCropInteractionStart: () => void;
  onValidationError: (message: string) => void;
};

const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const VIEWPORT_HEIGHT = 240;
const CORNER_SIZE = 20;
const CORNER_HIT_SIZE = 26;
const EDGE_HIT_SIZE = 12;
const MIN_CROP_SIZE = 54;
const ZOOM_STEP = 0.3;
const MIN_SCALE = 1;
const MAX_SCALE = 4;
const MAX_OUTPUT_EDGE = 4096;
const CORNER_HANDLES = ["nw", "ne", "se", "sw"] as const;
const EDGE_HANDLES = ["n", "e", "s", "w"] as const;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const nearlyEqual = (left: number, right: number) =>
  Math.abs(left - right) < 0.5;

const rectsEqual = (left: Rect, right: Rect) =>
  nearlyEqual(left.x, right.x) &&
  nearlyEqual(left.y, right.y) &&
  nearlyEqual(left.width, right.width) &&
  nearlyEqual(left.height, right.height);

const getDisplayedImage = (
  imageSize: ImageSize,
  viewportWidth: number,
  viewportHeight: number,
): DisplayedImage => {
  const scale = Math.min(
    viewportWidth / imageSize.naturalWidth,
    viewportHeight / imageSize.naturalHeight,
  );

  return {
    scale,
    width: imageSize.naturalWidth * scale,
    height: imageSize.naturalHeight * scale,
  };
};

const getInitialTransform = (
  displayedImage: DisplayedImage,
  viewportWidth: number,
  viewportHeight: number,
): TransformState => ({
  scale: MIN_SCALE,
  positionX: (viewportWidth - displayedImage.width) / 2,
  positionY: (viewportHeight - displayedImage.height) / 2,
});

const getImageRect = (
  displayedImage: DisplayedImage,
  transform: TransformState,
): ImageRect => ({
  x: transform.positionX,
  y: transform.positionY,
  width: displayedImage.width * transform.scale,
  height: displayedImage.height * transform.scale,
  scale: displayedImage.scale * transform.scale,
});

const createDefaultCrop = (bounds: Rect): Rect => ({ ...bounds });

const clampCropToBounds = (crop: Rect, bounds: Rect): Rect => {
  const minWidth = Math.min(MIN_CROP_SIZE, bounds.width);
  const minHeight = Math.min(MIN_CROP_SIZE, bounds.height);
  const width = clamp(crop.width, minWidth, bounds.width);
  const height = clamp(crop.height, minHeight, bounds.height);

  return {
    x: clamp(crop.x, bounds.x, bounds.x + bounds.width - width),
    y: clamp(crop.y, bounds.y, bounds.y + bounds.height - height),
    width,
    height,
  };
};

const resizeCrop = (
  crop: Rect,
  handle: DragHandle,
  dx: number,
  dy: number,
  bounds: Rect,
): Rect => {
  const minWidth = Math.min(MIN_CROP_SIZE, bounds.width);
  const minHeight = Math.min(MIN_CROP_SIZE, bounds.height);
  let left = crop.x;
  let top = crop.y;
  let right = crop.x + crop.width;
  let bottom = crop.y + crop.height;

  if (handle.includes("w")) left = clamp(left + dx, bounds.x, right - minWidth);
  if (handle.includes("e"))
    right = clamp(right + dx, left + minWidth, bounds.x + bounds.width);
  if (handle.includes("n")) top = clamp(top + dy, bounds.y, bottom - minHeight);
  if (handle.includes("s"))
    bottom = clamp(bottom + dy, top + minHeight, bounds.y + bounds.height);

  return { x: left, y: top, width: right - left, height: bottom - top };
};

const toImageCrop = (
  crop: Rect,
  imageRect: ImageRect,
  imageSize: ImageSize,
): ImageCrop => {
  const left = clamp(
    (crop.x - imageRect.x) / imageRect.scale,
    0,
    imageSize.naturalWidth,
  );
  const top = clamp(
    (crop.y - imageRect.y) / imageRect.scale,
    0,
    imageSize.naturalHeight,
  );
  const right = clamp(
    (crop.x + crop.width - imageRect.x) / imageRect.scale,
    0,
    imageSize.naturalWidth,
  );
  const bottom = clamp(
    (crop.y + crop.height - imageRect.y) / imageRect.scale,
    0,
    imageSize.naturalHeight,
  );

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top)),
  };
};

const getResizeHandle = (point: Point, crop: Rect): DragHandle | undefined => {
  const left = crop.x;
  const top = crop.y;
  const right = crop.x + crop.width;
  const bottom = crop.y + crop.height;
  const nearLeftCorner = Math.abs(point.x - left) <= CORNER_HIT_SIZE;
  const nearRightCorner = Math.abs(point.x - right) <= CORNER_HIT_SIZE;
  const nearTopCorner = Math.abs(point.y - top) <= CORNER_HIT_SIZE;
  const nearBottomCorner = Math.abs(point.y - bottom) <= CORNER_HIT_SIZE;
  const withinHorizontal =
    point.x >= left + CORNER_HIT_SIZE && point.x <= right - CORNER_HIT_SIZE;
  const withinVertical =
    point.y >= top + CORNER_HIT_SIZE && point.y <= bottom - CORNER_HIT_SIZE;

  if (nearTopCorner && nearLeftCorner) return "nw";
  if (nearTopCorner && nearRightCorner) return "ne";
  if (nearBottomCorner && nearRightCorner) return "se";
  if (nearBottomCorner && nearLeftCorner) return "sw";
  if (Math.abs(point.y - top) <= EDGE_HIT_SIZE && withinHorizontal) return "n";
  if (Math.abs(point.x - right) <= EDGE_HIT_SIZE && withinVertical) return "e";
  if (Math.abs(point.y - bottom) <= EDGE_HIT_SIZE && withinHorizontal)
    return "s";
  if (Math.abs(point.x - left) <= EDGE_HIT_SIZE && withinVertical) return "w";
  return undefined;
};

const loadImage = (file: File) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The selected image could not be decoded."));
    };
    image.src = url;
  });

const canvasToBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("The selected crop could not be created.")),
      "image/webp",
      0.92,
    );
  });

export async function cropImageFile(
  file: File,
  crop: ImageCrop,
): Promise<File> {
  const image = await loadImage(file);
  const sourceX = clamp(Math.round(crop.x), 0, image.naturalWidth - 1);
  const sourceY = clamp(Math.round(crop.y), 0, image.naturalHeight - 1);
  const sourceWidth = clamp(
    Math.round(crop.width),
    1,
    image.naturalWidth - sourceX,
  );
  const sourceHeight = clamp(
    Math.round(crop.height),
    1,
    image.naturalHeight - sourceY,
  );
  const outputScale = Math.min(
    1,
    MAX_OUTPUT_EDGE / Math.max(sourceWidth, sourceHeight),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * outputScale));
  canvas.height = Math.max(1, Math.round(sourceHeight * outputScale));
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("Image cropping is unavailable in this browser.");

  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  const blob = await canvasToBlob(canvas);
  const baseName = file.name.replace(/\.[^.]+$/, "") || "reference";
  return new File([blob], `${baseName}-crop.webp`, {
    type: "image/webp",
    lastModified: Date.now(),
  });
}

function ImageCropViewport({
  src,
  onCropChange,
  onInteractionStart,
}: {
  src: string;
  onCropChange: (crop: ImageCrop) => void;
  onInteractionStart: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<ReactZoomPanPinchRef | null>(null);
  const dragStateRef = useRef<CropDragState | null>(null);
  const onCropChangeRef = useRef(onCropChange);
  const onInteractionStartRef = useRef(onInteractionStart);
  onCropChangeRef.current = onCropChange;
  onInteractionStartRef.current = onInteractionStart;
  const [viewportWidth, setViewportWidth] = useState(0);
  const [imageSize, setImageSize] = useState<ImageSize>();
  const [displayedImage, setDisplayedImage] = useState<DisplayedImage>();
  const [transform, setTransform] = useState<TransformState>({
    scale: MIN_SCALE,
    positionX: 0,
    positionY: 0,
  });
  const [crop, setCrop] = useState<Rect>();
  const imageRect = useMemo(
    () =>
      displayedImage ? getImageRect(displayedImage, transform) : undefined,
    [displayedImage, transform],
  );
  const transformKey = displayedImage
    ? `${src}-${viewportWidth}-${displayedImage.width}-${displayedImage.height}`
    : src;

  const emitCrop = useCallback(
    (nextCrop: Rect, nextImageRect: ImageRect, nextImageSize: ImageSize) => {
      onCropChangeRef.current(
        toImageCrop(nextCrop, nextImageRect, nextImageSize),
      );
    },
    [],
  );

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateWidth = () => setViewportWidth(viewport.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setImageSize(undefined);
    setDisplayedImage(undefined);
    setTransform({ scale: MIN_SCALE, positionX: 0, positionY: 0 });
    setCrop(undefined);
  }, [src]);

  useEffect(() => {
    if (!imageSize || !viewportWidth) return;
    const nextDisplayedImage = getDisplayedImage(
      imageSize,
      viewportWidth,
      VIEWPORT_HEIGHT,
    );
    const nextTransform = getInitialTransform(
      nextDisplayedImage,
      viewportWidth,
      VIEWPORT_HEIGHT,
    );
    const nextImageRect = getImageRect(nextDisplayedImage, nextTransform);
    const nextCrop = createDefaultCrop(nextImageRect);
    setDisplayedImage(nextDisplayedImage);
    setTransform(nextTransform);
    setCrop(nextCrop);
    emitCrop(nextCrop, nextImageRect, imageSize);
  }, [emitCrop, imageSize, viewportWidth]);

  const handleTransform = useCallback(
    (nextTransform: TransformState) => {
      setTransform(nextTransform);
      if (!displayedImage || !imageSize || !crop) return;
      const nextImageRect = getImageRect(displayedImage, nextTransform);
      const nextCrop = clampCropToBounds(crop, nextImageRect);
      if (!rectsEqual(nextCrop, crop)) setCrop(nextCrop);
      emitCrop(nextCrop, nextImageRect, imageSize);
    },
    [crop, displayedImage, emitCrop, imageSize],
  );

  const viewportPoint = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const bounds = viewportRef.current?.getBoundingClientRect();
    return bounds
      ? { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
      : { x: 0, y: 0 };
  }, []);

  const handleCropPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const viewport = viewportRef.current;
      if (!viewport || !crop || !imageRect) return;
      const point = viewportPoint(event);
      const elementHandle = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-crop-handle]",
      )?.dataset.cropHandle as DragHandle | undefined;
      const handle = getResizeHandle(point, crop) ?? elementHandle;
      dragStateRef.current = handle
        ? {
            type: "resize",
            pointerId: event.pointerId,
            handle,
            startPointer: point,
            startCrop: crop,
          }
        : {
            type: "move",
            pointerId: event.pointerId,
            startPointer: point,
            startCrop: crop,
          };
      onInteractionStartRef.current();
      viewport.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    },
    [crop, imageRect, viewportPoint],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (
        !dragState ||
        dragState.pointerId !== event.pointerId ||
        !imageRect ||
        !imageSize
      )
        return;
      const point = viewportPoint(event);
      const dx = point.x - dragState.startPointer.x;
      const dy = point.y - dragState.startPointer.y;
      const nextCrop =
        dragState.type === "move"
          ? clampCropToBounds(
              {
                ...dragState.startCrop,
                x: dragState.startCrop.x + dx,
                y: dragState.startCrop.y + dy,
              },
              imageRect,
            )
          : resizeCrop(
              dragState.startCrop,
              dragState.handle,
              dx,
              dy,
              imageRect,
            );
      setCrop(nextCrop);
      emitCrop(nextCrop, imageRect, imageSize);
      event.preventDefault();
    },
    [emitCrop, imageRect, imageSize, viewportPoint],
  );

  const handlePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const viewport = viewportRef.current;
      if (dragStateRef.current?.pointerId === event.pointerId)
        dragStateRef.current = null;
      if (viewport?.hasPointerCapture(event.pointerId))
        viewport.releasePointerCapture(event.pointerId);
    },
    [],
  );

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!displayedImage) return;
      if ((event.target as HTMLElement).closest("[data-crop-control]")) return;
      event.preventDefault();
      event.stopPropagation();
      onInteractionStartRef.current();
      if (event.deltaY < 0) transformRef.current?.zoomIn(ZOOM_STEP);
      if (event.deltaY > 0) transformRef.current?.zoomOut(ZOOM_STEP);
    },
    [displayedImage],
  );

  return (
    <div
      ref={viewportRef}
      className="crop-viewport"
      style={{ height: VIEWPORT_HEIGHT, touchAction: "none" }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onWheelCapture={handleWheel}
    >
      {!displayedImage ? (
        <img
          className="crop-loader-image"
          src={src}
          alt=""
          draggable={false}
          onLoad={(event) =>
            setImageSize({
              naturalWidth: event.currentTarget.naturalWidth,
              naturalHeight: event.currentTarget.naturalHeight,
            })
          }
        />
      ) : (
        <TransformWrapper
          ref={transformRef}
          key={transformKey}
          initialScale={MIN_SCALE}
          minScale={MIN_SCALE}
          maxScale={MAX_SCALE}
          centerOnInit
          centerZoomedOut
          limitToBounds
          doubleClick={{ step: ZOOM_STEP }}
          wheel={{ disabled: true }}
          onPanningStart={() => onInteractionStartRef.current()}
          onPinchStart={() => onInteractionStartRef.current()}
          onZoomStart={() => onInteractionStartRef.current()}
          onInit={(ref) => handleTransform(ref.state)}
          onTransform={(_, state) => handleTransform(state)}
        >
          {({ zoomIn, zoomOut, resetTransform }) => (
            <>
              <TransformComponent
                wrapperClass="crop-transform-wrapper"
                contentClass="crop-transform-content"
              >
                <div
                  className="crop-image-frame"
                  style={{
                    width: displayedImage.width,
                    height: displayedImage.height,
                  }}
                >
                  <img
                    src={src}
                    alt="Selected search reference"
                    draggable={false}
                    onLoad={(event) =>
                      setImageSize({
                        naturalWidth: event.currentTarget.naturalWidth,
                        naturalHeight: event.currentTarget.naturalHeight,
                      })
                    }
                  />
                </div>
              </TransformComponent>
              <div className="crop-controls" data-crop-control>
                <button
                  type="button"
                  aria-label="Zoom in"
                  title="Zoom in"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    onInteractionStartRef.current();
                    zoomIn(ZOOM_STEP);
                  }}
                >
                  <Plus aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label="Zoom out"
                  title="Zoom out"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    onInteractionStartRef.current();
                    zoomOut(ZOOM_STEP);
                  }}
                >
                  <Minus aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label="Reset crop view"
                  title="Reset crop view"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    onInteractionStartRef.current();
                    resetTransform();
                  }}
                >
                  <RotateCcw aria-hidden />
                </button>
              </div>
            </>
          )}
        </TransformWrapper>
      )}

      {crop ? (
        <div
          className="crop-selection"
          style={{
            left: crop.x,
            top: crop.y,
            width: crop.width,
            height: crop.height,
          }}
          onPointerDown={handleCropPointerDown}
        >
          {CORNER_HANDLES.map((handle) => (
            <Fragment key={handle}>
              <span
                className={`crop-hit crop-hit-${handle}`}
                data-crop-handle={handle}
              />
              <span className={`crop-corner crop-corner-${handle}`} />
            </Fragment>
          ))}
          {EDGE_HANDLES.map((handle) => (
            <span
              key={handle}
              className={`crop-edge crop-edge-${handle}`}
              data-crop-handle={handle}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function validateFileList(files: FileList): File | string {
  if (files.length !== 1) return "Choose one image at a time.";
  const file = files[0];
  if (!file || !ACCEPTED_IMAGE_TYPES.has(file.type))
    return "Image must be JPEG, PNG, or WebP.";
  if (file.size > MAX_FILE_BYTES) return "Image must be 10 MB or smaller.";
  return file;
}

export function ImageCropDropzone({
  file,
  preview,
  disabled,
  onFileSelected,
  onRemove,
  onCropChange,
  onCropInteractionStart,
  onValidationError,
}: ImageCropDropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draggingOver, setDraggingOver] = useState(false);

  const selectFiles = useCallback(
    (files: FileList) => {
      const result = validateFileList(files);
      if (typeof result === "string") {
        onValidationError(result);
        return;
      }
      onFileSelected(result);
    },
    [onFileSelected, onValidationError],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDraggingOver(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (
      event.relatedTarget &&
      event.currentTarget.contains(event.relatedTarget as Node)
    )
      return;
    setDraggingOver(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      setDraggingOver(false);
      if (!disabled) selectFiles(event.dataTransfer.files);
    },
    [disabled, selectFiles],
  );

  return (
    <div className="image-input-column">
      {file && preview ? (
        <div
          className={`image-crop-dropzone${draggingOver ? " is-dragging" : ""}`}
          onDragEnter={handleDragOver}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <ImageCropViewport
            src={preview}
            onCropChange={onCropChange}
            onInteractionStart={onCropInteractionStart}
          />
          <button
            type="button"
            className="crop-remove"
            aria-label="Remove reference image"
            title="Remove reference image"
            onClick={onRemove}
          >
            <X aria-hidden />
          </button>
          {draggingOver ? (
            <div className="image-drop-overlay">
              <Upload aria-hidden />
              <strong>Drop to replace</strong>
            </div>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          className={`image-drop${draggingOver ? " is-dragging" : ""}`}
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          onDragEnter={handleDragOver}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <span className="upload-icon">
            <ImageIcon aria-hidden />
          </span>
          <strong>Add a reference image</strong>
          <small>Click or drop · JPEG, PNG or WebP · 10 MB max</small>
        </button>
      )}
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={(event) => {
          if (event.currentTarget.files) selectFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
    </div>
  );
}
