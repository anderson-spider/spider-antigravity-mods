import { useEffect, useId, useRef, type ReactNode } from 'react'
import { CloseIcon } from './Icons.tsx'

/**
 * Native modal `<dialog>` wrapper with top-layer rendering, `Esc` dismissal, focus return,
 * `closedby="any"` light dismiss, and a pointer-position fallback for browsers lacking `closedBy`.
 */
export function ModalDialog({
  open,
  title,
  maxWidth = 440,
  onClose,
  children,
  footer,
}: {
  open: boolean
  title: string
  maxWidth?: number
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleId = useId()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [open])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    const handleClose = () => {
      dialog.returnValue = ''
      onCloseRef.current()
    }

    dialog.addEventListener('close', handleClose)

    // Fallback for browsers without native `<dialog closedby="any">`: require both press
    // and release outside the dialog rect so text-selection drags ending on the backdrop do not dismiss.
    const supportsClosedBy = typeof HTMLDialogElement !== 'undefined' && 'closedBy' in HTMLDialogElement.prototype
    let pressedOutside = false
    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect()
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
    }
    const onPointerDown = (e: PointerEvent) => {
      pressedOutside = isOutside(e)
    }
    const onPointerUp = (e: PointerEvent) => {
      if (pressedOutside && isOutside(e) && dialog.open) {
        dialog.close()
      }
      pressedOutside = false
    }

    if (!supportsClosedBy) {
      dialog.addEventListener('pointerdown', onPointerDown)
      dialog.addEventListener('pointerup', onPointerUp)
    }

    return () => {
      dialog.removeEventListener('close', handleClose)
      if (!supportsClosedBy) {
        dialog.removeEventListener('pointerdown', onPointerDown)
        dialog.removeEventListener('pointerup', onPointerUp)
      }
    }
  }, [])

  if (!open) return null

  return (
    <dialog
      ref={dialogRef}
      className="app-dialog"
      style={{ maxWidth }}
      aria-labelledby={titleId}
      {...({ closedby: 'any' } as Record<string, string>)}
    >
      <div className="dialog-header">
        <h1 id={titleId} className="dialog-title">
          {title}
        </h1>
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close dialog">
          <CloseIcon />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer ? <div className="dialog-footer">{footer}</div> : null}
    </dialog>
  )
}
