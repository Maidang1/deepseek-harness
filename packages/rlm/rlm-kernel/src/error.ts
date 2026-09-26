/**
 * Kernel failure type shared by every provider of the `ctx.rlmKernel` seam.
 *
 * @module @deepseek-ai/dsh-rlm-kernel/error
 */

/** Failure raised when a kernel cannot serve a request. */
export class RlmKernelError extends Error {
  /**
   * @param message - description of the failure.
   * @param options - error options carrying the originating cause.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RlmKernelError'
  }
}
