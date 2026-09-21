/**
 * diver-example-hello — sample profile plugin for P4 install/uninstall.
 * Not mounted by @diver/bundle-companion; joins only via profile install.
 */
import type { Context } from 'cordis'

export const name = 'hello-tool'

export const inject = ['systemPrompt']

export function apply(ctx: Context) {
  ctx.systemPrompt.section({
    name: 'diver:hello-tool',
    order: 120,
    text: 'hello from a profile-installed plugin (P4 example)',
  })
  console.log('[hello-tool] profile plugin ready')
}
