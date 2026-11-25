import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import App from './App.vue'

const storage: Record<string, string> = {}
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => { storage[key] = value },
    removeItem: (key: string) => { delete storage[key] },
    clear: () => { for (const key of Object.keys(storage)) delete storage[key] },
  },
  configurable: true,
})

describe('App shell', () => {
  it('mounts the workspace with all rails and runs a simulation into the energy panel', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    expect(wrapper.find('.palette').exists()).toBe(true)
    expect(wrapper.find('.replay-panel').exists()).toBe(true)
    expect(wrapper.find('.energy-rail').exists()).toBe(true)
    expect(wrapper.text()).toContain('能量收支')

    await wrapper.get('.run-button').trigger('click')
    // simulate() awaits a requestAnimationFrame before propagating.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await nextTick()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await nextTick()

    expect(wrapper.find('.balance-badge').exists()).toBe(true)
    expect(wrapper.find('.energy-panel').exists()).toBe(true)
    expect(wrapper.findAll('.energy-row-main').length).toBeGreaterThan(0)
    wrapper.unmount()
  })

  it('switches to the bundled verification scenario', async () => {
    const wrapper = mount(App, { attachTo: document.body })
    await wrapper.get('.scenario-menu select').setValue('energy-verification')
    await nextTick()
    expect(wrapper.text()).toContain('能量验证 · 摆锤分岔')
    // The verification scene starts from a pendulum and contains a ramp.
    const labels = wrapper.findAll('.piece-label').map(node => node.text())
    expect(labels).toContain('摆锤')
    expect(labels).toContain('储能坡')
    wrapper.unmount()
  })
})
