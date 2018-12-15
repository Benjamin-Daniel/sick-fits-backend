const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('crypto');
const { promisify } = require('util');
const { transport, makeANiceEmail } = require('../mail');
const { hasPermission } = require('../utils');
const stripe = require('../stripe');

const Mutations = {
    async createItem(parent, args, ctx, info) {
        if (!ctx.request.userId) {
            throw new Error('You need to be signed in to do that!');
        }
        // TODO check if they are logged in
        const item = await ctx.db.mutation.createItem({
            data: {
                // this is how we create a relationship between the user and item
                user: {
                    connect: {
                        id: ctx.request.userId,
                    },
                },
                ...args
            }
        }, info);
        return item;
    },
    async updateItem(parent, args, ctx, info) {
        // frist take a copy of the updates 
        const updates = { ...args };
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
        const where = { id: args.id }
        // find the item
        const item = await ctx.db.query.item({ where }, `{ id title user { id } }`)
        // check if they own that item 
        const ownsItem = item.user.id === ctx.request.userId;
        const hasPermission = ctx.request.user.permissions.some(permission => {
            ['ADMIN', 'ITEMDELETE'].includes(permission);
        });
        if (!ownsItem && !hasPermission) {
            throw new Error("You don't have permission to do that!")
        }
        // delete it
        return ctx.db.mutation.deleteItem({ where }, info);
    },
    async signup(parent, args, ctx, info) {
        //lowercase their email
        args.email = args.email.toLowerCase();
        // hash their password
        const password = await bcrypt.hash(args.password, 10);
        // create user in the database
        const user = await ctx.db.mutation.createUser({
            data: {
                ...args,
                password,
                permissions: { set: ['USER'] },
            }
        }, info);
        // create jwt token
        const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
        // we set the jwt as a cookie on the response 
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year cookie
        });
        // finally return the user
        return user;
    },
    async signin(parent, { password, email }, ctx, info) {
        // 1. check if there is a user with that email
        const user = await ctx.db.query.user({ where: { email } });
        if (!user) {
            throw new Error(`No user with such found for user ${email}`);
        }
        // 2. check if their password is correct
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            throw new Error('Invalid Password');
        }
        // 3. generate the JWT Token
        const token = jwt.sign({ userId: user.id }, process.env.APP_SECRET);
        // 4. Set the cookie with the token
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year cookie
        });
        // 5. Return the user
        return user;
    },
    signout(parent, args, ctx, info) {
        ctx.response.clearCookie('token');
        return { message: 'Goodbye!' }
    },
    async requestReset(parent, args, ctx, info) {
        // 1. check if this is a real user
        const user = await ctx.db.query.user({ where: { email: args.email } });
        if (!user) {
            throw new Error(`No user with such found for user ${args.email}`);
        }
        // 2. set a reset token on that user
        const resetToken = (await promisify(randomBytes)(20)).toString('hex');
        const resetTokenExpiry = Date.now() + 3600000;
        const res = await ctx.db.mutation.updateUser({
            where: { email: args.email },
            data: { resetToken: resetToken, resetTokenExpiry: resetTokenExpiry }
        });
        // 3. email them that reset token
        const mailRes = await transport.sendMail({
            from: 'benjamindaniel706@gmail.com',
            to: user.email,
            subject: "Your Password Reset Token",
            html: makeANiceEmail(`Your password Reset Token is here! 
            \n\n
            <a href="${process.env.
                    FRONTEND_URL}/reset?resetToken=${resetToken}">
                Click Here to reset
            </a>`)
        });
        // 4. return the message
        return { message: "Thanks!" }
    },
    async resetPassword(parent, args, ctx, info) {
        // 1. Check if the password match
        if (args.password !== args.confirmPassword) {
            throw new Error('Yo password don\'t match');
        }
        // 2. check if its is a legit reset Token
        // 3. Check if it is  expired 
        const [user] = await ctx.db.query.users({
            where: {
                resetToken: args.resetToken,
                resetTokenExpiry_gte: Date.now() - 3600000,
            },
        });
        if (!user) {
            throw new Error('This token is either expired or invalid');
        };
        // 4. Hash there new Password
        const password = await bcrypt.hash(args.password, 10);
        // 5. save the new password to the user and remove old resetToken fields
        const updatedUser = await ctx.db.mutation.updateUser({
            where: { email: user.email },
            data: {
                password,
                resetToken: null,
                resetTokenExpiry: null,
            }
        });
        // 6. Generate jwt
        const token = jwt.sign({ userId: updatedUser.id }, process.env.APP_SECRET);
        // 7. set the jwt cookie
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year cookie
        });
        // 8. return the user
        return updatedUser;

    },
    async updatePermissions(parent, args, ctx, info) {
        // 1. check if they are logged in
        if (!ctx.request.userId) {
            throw new Error('You must be logged in');
        }
        // 2. Query the current user
        const currentUser = await ctx.db.query.user({
            where: {
                id: ctx.request.userId
            }
        }, info);
        // 3. Check if they have the permissions to do this
        hasPermission(currentUser, ['ADMIN', 'PERMISSIONUPDATE']);
        // 4. Update the permissions
        return ctx.db.mutation.updateUser({
            data: {
                permissions: {
                    set: args.permissions,
                }
            },
            where: {
                id: args.userId
            },
        }, info)
    },
    async addToCart(parent, args, ctx, info) {
        // 1. make sure they are signed in
        const { userId } = ctx.request;
        if (!userId) {
            throw new Error('You must be signed In soon');
        }
        // 2. Query Users current Cart
        const [existingCartItem] = await ctx.db.query.cartItems({
            where: {
                user: { id: userId },
                item: { id: args.id },
            },
        });
        // 3. Check if that item is already in their cart and increment by one
        if (existingCartItem) {
            return ctx.db.mutation.updateCartItem({
                where: { id: existingCartItem.id },
                data: { quantity: existingCartItem.quantity + 1 },
            }, info);
        }
        // 4. if it's not create a fresh cartItem from that user
        return ctx.db.mutation.createCartItem({
            data: {
                user: {
                    connect: { id: userId },
                },
                item: {
                    connect: { id: args.id },
                },
            }
        }, info);
    },
    async removeFromCart(parent, args, ctx, info) {
        // 1. find the cart Item
        const cartItem = await ctx.db.query.cartItem({
            where: {
                id: args.id,
            },
        }, ` { id, user { id } } `);
        // 1.5 Make sure we found an item
        if (!cartItem) throw new Error('No CartItem Found!');
        // 2. Make sure they own the cart
        if (cartItem.user.id !== ctx.request.userId) {
            throw new Error('Cheating Uhhhn!!!');
        };
        // 3. Delete the cart Item
        return ctx.db.mutation.deleteCartItem({
            where: { id: args.id },
        }, info);
    },
    async createOrder(parent, args, ctx, info) {
        // 1. query the current user and make sure they are signed in
        const { userId } = ctx.request;
        if (!userId) throw new Error('You must be signed in to complete this order.');
        const user = await ctx.db.query.user({ where: { id: userId } },
            ` { 
                id 
                name 
                email 
                cart { 
                    id 
                    quantity 
                    item { title price id description image largeImage } 
                } } `);
        // 2. recalculate the total for the price
        const amount = user.cart.reduce((tally, cartItem) => tally + cartItem.item.price * cartItem.quantity, 0);
        // 3. create stripe charge (turn token into $$$)
        const charge = await stripe.charges.create({
            amount: amount,
            currency: 'USD',
            source: args.token,
        });
        // 4. Convert CartItem to OrderItems
        const orderItems = user.cart.map(cartItem => {
            const orderItem = {
                ...cartItem.item,
                quantity: cartItem.quantity,
                user: { connect: { id: userId } }
            };
            delete orderItem.id;
            return orderItem;
        });
        // 5. Create Order
        const order = await ctx.db.mutation.createOrder({
            data: {
                total: charge.amount,
                charge: charge.id,
                items: { create: orderItems },
                user: { connect: { id: userId } },
            },
        });
        // 6. clean up - clear the users cart, delete CartItems
        const cartItemIds = user.cart.map(cartItem => cartItem.id);
        await ctx.db.mutation.deleteManyCartItems({
            where: {
                id_in: cartItemIds,
            },
        });
        // 7. return the order to the client
        return order;
    },
};

module.exports = Mutations;
