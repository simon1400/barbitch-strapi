/**
 * admin-user controller
 */

import { factories } from '@strapi/strapi'
import bcrypt from 'bcryptjs'

export default factories.createCoreController('api::admin-user.admin-user', ({ strapi }) => ({
  // Кастомный endpoint для проверки логина
  async login(ctx) {
    const { username, password } = ctx.request.body

    if (!username || !password) {
      return ctx.badRequest('Username and password are required')
    }

    try {
      // Находим пользователя по username
      const users = await strapi.entityService.findMany('api::admin-user.admin-user', {
        filters: { username, isActive: true },
        limit: 1,
      })

      if (!users || users.length === 0) {
        return ctx.unauthorized('Invalid credentials')
      }

      const user = users[0]

      // Проверяем пароль
      const validPassword = await bcrypt.compare(password, user.password)

      if (!validPassword) {
        return ctx.unauthorized('Invalid credentials')
      }

      // Возвращаем данные пользователя (без пароля)
      return {
        username: user.username,
        role: user.role,
        id: user.id,
      }
    } catch (error) {
      console.error('Login error:', error)
      return ctx.internalServerError('An error occurred during login')
    }
  },
}))
