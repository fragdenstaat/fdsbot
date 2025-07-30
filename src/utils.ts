/**
 * Utility function to wait for a specified number of milliseconds.
 * It can be aborted using an AbortSignal.
 * @param ms - The number of milliseconds to wait
 * @param signal AbortSignal to cancel the wait
 * @returns true if the wait completed, false if it was aborted
 */
export async function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const id = setTimeout(() => resolve(true), ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(id)
        resolve(false)
      },
      { once: true }
    )
  })
}
