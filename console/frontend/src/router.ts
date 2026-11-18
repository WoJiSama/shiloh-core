import { createRouter, createWebHashHistory } from 'vue-router'
import { confirmLeave } from './composables/useUnsavedGuard'
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: () => import('./pages/ConsoleHome.vue') },
    { path: '/robots', component: () => import('./pages/WorkspaceRobots.vue') },
    { path: '/robots/:id/:tab?', component: () => import('./pages/WorkspaceRobot.vue') },
    { path: '/connections/:id?', component: () => import('./pages/WorkspaceConnections.vue') },
    ...(['resources', 'runtime', 'system'] as const).map((section) => ({
      path: '/' + section,
      component: () => import('./pages/WorkspaceHub.vue'),
      props: { section }
    })),
    {
      path: '/bot/:qq(\\d{4,12})',
      component: () => import('./pages/LegacyBotRoute.vue'),
      props: true
    },
    {
      path: '/groups',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'groups' }
    },
    {
      path: '/group-admin',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'group-admin' }
    },
    {
      path: '/persona',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'persona' }
    },
    {
      path: '/conversation',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'conversation' }
    },
    {
      path: '/ai',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'ai' }
    },
    {
      path: '/pipeline',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'pipeline' }
    },
    {
      path: '/risk',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'risk' }
    },
    {
      path: '/games',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'games' }
    },
    {
      path: '/draw',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'draw' }
    },
    {
      path: '/observe',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'observe' }
    },
    {
      path: '/simulation',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'simulation' }
    },
    {
      path: '/person-profiles',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'person-profiles' }
    },
    {
      path: '/trusteeship',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'trusteeship' }
    },
    {
      path: '/life',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'life' }
    },
    {
      path: '/tokens',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'tokens' }
    },
    {
      path: '/style',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'style' }
    },
    {
      path: '/observe/details',
      component: () => import('./pages/EmbeddedPage.vue'),
      props: { kind: 'observe' }
    },
    {
      path: '/commands',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'commands' }
    },
    {
      path: '/semantic',
      component: () => import('./pages/ConsoleFeaturePage.vue'),
      props: { feature: 'semantic' }
    },
    { path: '/qzone', redirect: '/' },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ],
  scrollBehavior: () => ({ top: 0 })
})
router.beforeEach((to, from) => to.fullPath === from.fullPath || confirmLeave())
