const UID = 'api::service-provided.service-provided';

const red = '🟥', green = '🟩', yellow = '🟨';

async function validateOfferMoney(event: any) {

  const dataCurrent = event.params.data

  const documentId = dataCurrent.documentId

  const current = documentId
    ? await strapi.documents(UID).findOne({
        documentId,
        populate: {
          personal: { fields: ['ratePercent'] },
          offer: { fields: ['price'] },
        }
      })
    : null;

    const offer = dataCurrent?.offer?.connect.length ? dataCurrent?.offer?.connect : current.offer
    const personal = dataCurrent?.personal?.connect.length ? dataCurrent?.personal?.connect : current.personal

    const staffSalaries = Number(dataCurrent.staffSalaries)
    const salonSalaries = Number(dataCurrent.salonSalaries)

    const mustStaffSallary = offer.price * (personal.ratePercent / 100)
    const mustSalonSallary = offer.price * ((100 - personal.ratePercent) / 100)

    const notEqualStaffSallery = mustStaffSallary !== staffSalaries
    // const notEqualSalonSallery = mustSalonSallary !== salonSalaries
    const salonSalleryGreater = salonSalaries > mustSalonSallary
    const salonSalleryLess = salonSalaries < mustSalonSallary
    
    let result = green

    if(salonSalleryLess && dataCurrent.sale || notEqualStaffSallery || salonSalleryGreater){
      result = yellow
    }

    if(salonSalleryLess && !dataCurrent.sale){
      result = red
    }
    
    event.params.data.verify = result
}

export default {
  async beforeCreate(event) {
    await validateOfferMoney(event);
  },
  async beforeUpdate(event) {
    await validateOfferMoney(event);
  },
};