const Mutations = {
    async createItem(parent, args, ctx, info) {
        // TODO check if they are logged in
        const item = await ctx.db.mutation.createItem({
            data: {
                ...args
            }
        }, info);
        return item;
    },
    async updateItem(parent, args, ctx, info) {
        // frist take a copy of the updates 
        const updates = {...args};
        // remove the id from the updates
        delete updates.id;
        return await ctx.db.mutation.updateItem({
            data: updates,
            where: {
                id: args.id
            }
        }, info);
    },
    async deleteItem(parent, args, ctx, info) {
        const where = {id: args.id}
        // find the item
        const item = await ctx.db.query.item({where}, `{ id title }`)
        // check if they own that item 
        // delete it
        return ctx.db.mutation.deleteItem({where}, info);
    },
};

module.exports = Mutations;
