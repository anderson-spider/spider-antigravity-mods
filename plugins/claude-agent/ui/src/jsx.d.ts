import 'react'

declare module 'react' {
  interface DialogHTMLAttributes<T> {
    closedby?: 'any' | 'closerequest' | 'none'
  }
}
