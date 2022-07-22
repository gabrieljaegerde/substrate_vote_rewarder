import { getReferendumCollection } from "../index.js";

export const insertReferendum = async (referendum) => {
    const referendumCol = await getReferendumCollection();
    const maybeInDb = await referendumCol.findOne({
        referendum_index: parseInt(referendum.id)
    });
    if (maybeInDb) {
        return false;
    }

    await referendumCol.insertOne(referendum);
    return true;
};