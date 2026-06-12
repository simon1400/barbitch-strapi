/**
 * admin-user controller
 */

import { factories } from '@strapi/strapi'
import bcrypt from 'bcryptjs'
import { signSession, verifySession, tokenFromCtx } from '../../../utils/admin-jwt'

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

      // Выдаём подписанный сессионный токен (роль зашита в токене, проверяется на сервере)
      const jwt = signSession({
        id: user.id as number,
        username: user.username as string,
        role: user.role as 'owner' | 'administrator' | 'master',
      })

      // Возвращаем данные пользователя (без пароля)
      return {
        username: user.username,
        role: user.role,
        id: user.id,
        jwt,
      }
    } catch (error) {
      console.error('Login error:', error)
      return ctx.internalServerError('An error occurred during login')
    }
  },

  // Проверка статуса пользователя (активен ли он)
  async checkStatus(ctx) {
    // Только владелец токена может узнавать СВОЙ статус (никакой энумерации по id)
    const session = verifySession(tokenFromCtx(ctx))
    if (!session) {
      return ctx.unauthorized('Authentication required')
    }

    const userId = session.id

    try {
      const user = await strapi.entityService.findOne('api::admin-user.admin-user', userId, {
        fields: ['isActive'],
      })

      if (!user) {
        return ctx.notFound('User not found')
      }

      return {
        isActive: user.isActive,
      }
    } catch (error) {
      console.error('Check status error:', error)
      return ctx.internalServerError('An error occurred while checking user status')
    }
  },

  // Получение данных администратора для личного кабинета
  async getAdministratorData(ctx) {
    const { username } = ctx.params

    if (!username) {
      return ctx.badRequest('Username is required')
    }

    // Доступ только к СВОИМ данным (или владельцу) — иначе любой мог вытащить
    // зарплаты/штрафы/авансы всего персонала перебором username
    const session = verifySession(tokenFromCtx(ctx))
    if (!session) {
      return ctx.unauthorized('Authentication required')
    }
    if (session.role !== 'owner' && session.username !== username) {
      return ctx.forbidden('You can only access your own data')
    }

    try {
      // Находим пользователя по username с привязанным мастером
      const users: any = await strapi.entityService.findMany('api::admin-user.admin-user', {
        filters: { username, isActive: true, role: 'administrator' },
        populate: ['masterPersonal'],
        limit: 1,
      })

      if (!users || users.length === 0) {
        return ctx.notFound('Administrator not found')
      }

      const user = users[0]

      // Находим персонал с таким же именем
      const personals: any = await strapi.entityService.findMany('api::personal.personal', {
        filters: {
          name: username,
          position: 'administrator'
        },
        populate: ['penalties', 'payroll', 'work_time', 'advances', 'rates'],
        limit: 1,
      })

      if (!personals || personals.length === 0) {
        return ctx.notFound('Personal data not found')
      }

      const personal: any = personals[0]

      // Получаем зарплаты
      const salaries: any = await strapi.entityService.findMany('api::salary.salary', {
        filters: {
          personal: personal.id
        },
        sort: 'date:desc'
      })

      // Получаем доп. прибыль (премии) из add-moneys
      const extraProfits: any = await strapi.entityService.findMany('api::add-money.add-money', {
        filters: {
          personal: personal.id
        },
        sort: 'date:desc',
        publicationState: 'live'
      })

      // Получаем смены
      const shifts: any = await strapi.entityService.findMany('api::shift.shift', {
        sort: 'from:desc',
        populate: ['days'],
        limit: 10
      })

      // Данные мастера (если администратор также работает мастером)
      let masterData = null
      if (user.masterPersonal) {
        const masterPersonalId = user.masterPersonal.id

        // Получаем полные данные мастера
        const masterPersonal: any = await strapi.entityService.findOne('api::personal.personal', masterPersonalId, {
          populate: ['penalties', 'payroll', 'advances', 'rates']
        })

        // Получаем услуги, оказанные мастером (заработок)
        const servicesProvided: any = await strapi.entityService.findMany('api::service-provided.service-provided', {
          filters: {
            personal: masterPersonalId
          },
          populate: ['offer'],
          sort: 'date:desc'
        })

        // Получаем премии мастера
        const masterExtraProfits: any = await strapi.entityService.findMany('api::add-money.add-money', {
          filters: {
            personal: masterPersonalId
          },
          sort: 'date:desc',
          publicationState: 'live'
        })

        // Получаем зарплаты мастера
        const masterSalaries: any = await strapi.entityService.findMany('api::salary.salary', {
          filters: {
            personal: masterPersonalId
          },
          sort: 'date:desc'
        })

        masterData = {
          personalId: masterPersonalId,
          name: masterPersonal?.name || '',
          ratePercent: masterPersonal?.ratePercent || 0,
          excessThreshold: masterPersonal?.excessThreshold || 0,
          servicesProvided: servicesProvided || [],
          penalties: masterPersonal?.penalties || [],
          payrolls: masterPersonal?.payroll || [],
          advances: masterPersonal?.advances || [],
          extraProfits: masterExtraProfits || [],
          salaries: masterSalaries || []
        }
      }

      return {
        username: user.username,
        role: user.role,
        personal: {
          name: personal.name || '',
          position: personal.position || 'administrator',
          excessThreshold: personal.excessThreshold || 0,
          rates: personal.rates || [],
          ratePercent: personal.ratePercent || 0
        },
        penalties: personal.penalties || [],
        payrolls: personal.payroll || [],
        workTimes: personal.work_time || [],
        advances: personal.advances || [],
        salaries: salaries || [],
        extraProfits: extraProfits || [],
        shifts: shifts || [],
        masterData: masterData
      }
    } catch (error) {
      console.error('Get administrator data error:', error)
      return ctx.internalServerError('An error occurred while fetching administrator data')
    }
  },
}))
