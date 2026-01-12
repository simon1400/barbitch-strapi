// Скрипт для создания начальных наград программы лояльности
// Запустите через Node.js после запуска Strapi

const rewards = [
  {
    title: '20% скидка на услуги',
    description: 'Скидка 20% на все услуги салона',
    requiredPoints: 3000,
    rewardType: 'discount_percent',
    rewardValue: 20,
    isActive: true,
    order: 1,
    year: 2026,
  },
  {
    title: 'Ваучер на 400 крон',
    description: 'Подарочный ваучер на 400 Kč',
    requiredPoints: 5000,
    rewardType: 'voucher',
    rewardValue: 400,
    isActive: true,
    order: 2,
    year: 2026,
  },
  {
    title: '50% скидка на полировку',
    description: 'Скидка 50% на услугу полировки',
    requiredPoints: 8000,
    rewardType: 'discount_percent',
    rewardValue: 50,
    isActive: true,
    order: 3,
    year: 2026,
  },
];

async function seedRewards() {
  console.log('Creating loyalty rewards...');

  for (const reward of rewards) {
    console.log(`Creating: ${reward.title}`);
    // Здесь будет код для создания через Strapi API
    // Или вручную через админ-панель
  }

  console.log('Done! Please create these rewards manually in Strapi admin panel.');
  console.log('See LOYALTY_SETUP.md for detailed instructions.');
}

module.exports = { rewards, seedRewards };

// Если запускается напрямую
if (require.main === module) {
  console.log('=== Loyalty Rewards Seed Data ===\n');
  rewards.forEach((reward, index) => {
    console.log(`${index + 1}. ${reward.title}`);
    console.log(`   Required: ${reward.requiredPoints} Kč`);
    console.log(`   Type: ${reward.rewardType}`);
    console.log(`   Value: ${reward.rewardValue}`);
    console.log('');
  });
  console.log('Create these in Strapi admin panel: Content Manager → Loyalty Rewards');
}
