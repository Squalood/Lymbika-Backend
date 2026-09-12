export default {
  routes: [
    {
      method: 'PUT',
      path: '/profile',
      handler: 'profile.updateMe',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
