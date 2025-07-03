const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Serve static files from the current directory (where index.html is)
app.use(express.static(path.join(__dirname)));

// Store connected users and their usernames
// user structure: { id: socket.id, username: '...' }
const users = [];

// Store rooms and their properties
// room structure: { id: '...', name: '...', pin: '...', history: [], users: Set<socket.id> }
const rooms = new Map();

// Create a default 'general' room if it doesn't exist
if (!rooms.has('general')) {
    rooms.set('general', {
        id: 'general',
        name: 'General',
        pin: null, // No PIN for the general room
        history: [],
        users: new Set() // Store socket IDs
    });
}

// Helper function to get room list for clients
function getRoomList() {
    return Array.from(rooms.values()).map(room => ({
        id: room.id,
        name: room.name,
        hasPin: !!room.pin // Indicate if a PIN is required
    }));
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Send initial room list to the newly connected client
    socket.emit('update room list', getRoomList());

    // Handle initial username setting
    socket.on('set initial username', (newUsername) => {
        const trimmedUsername = newUsername.trim();
        if (trimmedUsername && !users.some(u => u.username === trimmedUsername)) {
            socket.username = trimmedUsername;
            users.push({ id: socket.id, username: trimmedUsername });
            socket.emit('username accepted', trimmedUsername);
            console.log(`User ${trimmedUsername} set as username for socket ${socket.id}.`);

            // *** IMPORTANT CHANGE: REMOVED AUTO-JOIN TO 'general' ROOM HERE ***
            // User will now explicitly create or join a room from the lobby.

            // Update room list for all clients after a user connects/sets username
            io.emit('update room list', getRoomList());

        } else {
            socket.emit('username rejected', 'Username is empty or already taken.');
        }
    });

    // Handle username change command (/nick)
    socket.on('change username', (newUsername) => {
        const trimmedNewUsername = newUsername.trim();
        if (!trimmedNewUsername) {
            socket.emit('room action feedback', 'Username cannot be empty.');
            return;
        }
        if (users.some(u => u.username === trimmedNewUsername && u.id !== socket.id)) {
            socket.emit('room action feedback', `Username "${trimmedNewUsername}" is already taken.`);
            return;
        }

        const oldUsername = socket.username;
        if (oldUsername) {
            // Update the username in the global users list
            const userIndex = users.findIndex(u => u.id === socket.id);
            if (userIndex !== -1) {
                users[userIndex].username = trimmedNewUsername;
            }

            // Update username in all rooms the user is currently in
            for (const [roomId, room] of rooms) {
                if (room.users.has(socket.id)) {
                    room.history.push({ type: 'system', text: `${oldUsername} is now ${trimmedNewUsername}.`, timestamp: Date.now() });
                    io.to(roomId).emit('chat message', { room: roomId, user: 'System', text: `${oldUsername} is now ${trimmedNewUsername}.`, timestamp: Date.now() });
                    // Re-emit user list for affected rooms to show new username
                    io.to(roomId).emit('update user list', Array.from(room.users).map(id => io.sockets.sockets.get(id).username));
                }
            }
            socket.username = trimmedNewUsername; // Update socket object's username property
            socket.emit('username updated', trimmedNewUsername);
            console.log(`User ${oldUsername} changed username to ${trimmedNewUsername}.`);
        } else {
            socket.emit('room action feedback', 'You must set an initial username first.');
        }
    });


    // Handle room creation
    socket.on('create room', ({ name, pin }) => {
        if (!socket.username) {
            socket.emit('room action feedback', 'Please set your username first.');
            return;
        }

        const trimmedName = name.trim();
        const trimmedPin = pin ? pin.trim() : null;

        if (!trimmedName || !trimmedPin) {
            socket.emit('room action feedback', 'Room name and PIN cannot be empty.');
            return;
        }

        if (rooms.has(trimmedPin)) {
            socket.emit('room action feedback', `Room with PIN "${trimmedPin}" already exists.`);
            return;
        }

        // Leave current room if in one
        if (socket.currentRoomId && rooms.has(socket.currentRoomId)) {
            const oldRoom = rooms.get(socket.currentRoomId);
            oldRoom.users.delete(socket.id);
            socket.leave(socket.currentRoomId);
            io.to(socket.currentRoomId).emit('chat message', { room: socket.currentRoomId, user: 'System', text: `${socket.username} has left the room.`, timestamp: Date.now() });
            io.to(socket.currentRoomId).emit('update user list', Array.from(oldRoom.users).map(id => io.sockets.sockets.get(id).username));
            console.log(`${socket.username} left room ${oldRoom.name} (${oldRoom.id}) to create new room.`);
        }

        const newRoom = {
            id: trimmedPin, // Use PIN as ID for simplicity
            name: trimmedName,
            pin: trimmedPin,
            history: [],
            users: new Set()
        };
        rooms.set(trimmedPin, newRoom);

        socket.join(trimmedPin);
        newRoom.users.add(socket.id);
        socket.currentRoomId = trimmedPin; // Store current room ID on the socket

        newRoom.history.push({ type: 'system', text: `${socket.username} created and joined the room.`, timestamp: Date.now() });

        socket.emit('room joined success', {
            roomName: newRoom.name,
            roomId: newRoom.id,
            history: newRoom.history,
            usersInRoom: Array.from(newRoom.users).map(id => io.sockets.sockets.get(id).username)
        });

        io.to(trimmedPin).emit('update user list', Array.from(newRoom.users).map(id => io.sockets.sockets.get(id).username));
        io.emit('update room list', getRoomList()); // Update room list for all clients
        console.log(`Room "${trimmedName}" created with PIN "${trimmedPin}" by ${socket.username}.`);
    });

    // Handle joining a room by PIN
    socket.on('join room by pin', (pin) => {
        if (!socket.username) {
            socket.emit('room action feedback', 'Please set your username first.');
            return;
        }

        const trimmedPin = pin.trim();

        // Added explicit check for empty PIN
        if (!trimmedPin) {
            socket.emit('room action feedback', 'Please enter a room PIN/ID.');
            return;
        }

        const roomToJoin = rooms.get(trimmedPin);

        if (!roomToJoin) {
            socket.emit('room action feedback', 'Room not found with that PIN.');
            return;
        }

        // Prevent joining if already in this room
        if (socket.currentRoomId === trimmedPin) {
            socket.emit('room action feedback', 'You are already in this room.');
            return;
        }

        // Leave current room if in one
        if (socket.currentRoomId && rooms.has(socket.currentRoomId)) {
            const oldRoom = rooms.get(socket.currentRoomId);
            oldRoom.users.delete(socket.id);
            socket.leave(socket.currentRoomId);
            io.to(socket.currentRoomId).emit('chat message', { room: socket.currentRoomId, user: 'System', text: `${socket.username} has left the room.`, timestamp: Date.now() });
            io.to(socket.currentRoomId).emit('update user list', Array.from(oldRoom.users).map(id => io.sockets.sockets.get(id).username));
            console.log(`${socket.username} left room ${oldRoom.name} (${oldRoom.id}) to join new room.`);
        }

        socket.join(trimmedPin);
        roomToJoin.users.add(socket.id);
        socket.currentRoomId = trimmedPin; // Store current room ID on the socket

        roomToJoin.history.push({ type: 'system', text: `${socket.username} has joined the room.`, timestamp: Date.now() });

        socket.emit('room joined success', {
            roomName: roomToJoin.name,
            roomId: roomToJoin.id,
            history: roomToJoin.history,
            usersInRoom: Array.from(roomToJoin.users).map(id => io.sockets.sockets.get(id).username)
        });

        io.to(trimmedPin).emit('update user list', Array.from(roomToJoin.users).map(id => io.sockets.sockets.get(id).username));
        console.log(`${socket.username} joined room "${roomToJoin.name}" (${roomToJoin.id}).`);
    });

    // Handle switching rooms from the sidebar/quick switcher
    socket.on('switch room', (newRoomId) => {
        if (!socket.username) {
            socket.emit('room action feedback', 'Please set your username first.');
            return;
        }

        const roomToSwitchTo = rooms.get(newRoomId);

        if (!roomToSwitchTo) {
            socket.emit('room action feedback', 'Room not found.');
            return;
        }

        // Prevent switching if already in this room
        if (socket.currentRoomId === newRoomId) {
            socket.emit('room action feedback', 'You are already in this room.');
            return;
        }

        // Leave current room if in one
        if (socket.currentRoomId && rooms.has(socket.currentRoomId)) {
            const oldRoom = rooms.get(socket.currentRoomId);
            oldRoom.users.delete(socket.id);
            socket.leave(socket.currentRoomId);
            io.to(socket.currentRoomId).emit('chat message', { room: socket.currentRoomId, user: 'System', text: `${socket.username} has left the room.`, timestamp: Date.now() });
            io.to(socket.currentRoomId).emit('update user list', Array.from(oldRoom.users).map(id => io.sockets.sockets.get(id).username));
            console.log(`${socket.username} left room ${oldRoom.name} (${oldRoom.id}) to switch.`);
        }

        socket.join(newRoomId);
        roomToSwitchTo.users.add(socket.id);
        socket.currentRoomId = newRoomId; // Update current room ID on the socket

        roomToSwitchTo.history.push({ type: 'system', text: `${socket.username} has joined the room.`, timestamp: Date.now() });

        socket.emit('room joined success', {
            roomName: roomToSwitchTo.name,
            roomId: roomToSwitchTo.id,
            history: roomToSwitchTo.history,
            usersInRoom: Array.from(roomToSwitchTo.users).map(id => io.sockets.sockets.get(id).username)
        });

        io.to(newRoomId).emit('update user list', Array.from(roomToSwitchTo.users).map(id => io.sockets.sockets.get(id).username));
        console.log(`${socket.username} switched to room "${roomToSwitchTo.name}" (${roomToSwitchTo.id}).`);
    });

    // Handle leaving the current room
    socket.on('leave current room', () => {
        if (socket.currentRoomId && rooms.has(socket.currentRoomId)) {
            const roomToLeave = rooms.get(socket.currentRoomId);
            roomToLeave.users.delete(socket.id);
            socket.leave(socket.currentRoomId);

            io.to(socket.currentRoomId).emit('chat message', { room: socket.currentRoomId, user: 'System', text: `${socket.username} has left the room.`, timestamp: Date.now() });
            io.to(socket.currentRoomId).emit('update user list', Array.from(roomToLeave.users).map(id => io.sockets.sockets.get(id).username));

            console.log(`${socket.username} left room ${roomToLeave.name} (${roomToLeave.id}).`);
            socket.currentRoomId = null; // Clear current room ID
            socket.emit('entered lobby'); // Tell client to go back to lobby UI
        } else {
            socket.emit('room action feedback', 'You are not currently in a room.');
        }
    });


    // Handle chat messages
    socket.on('chat message', (data) => {
        if (socket.username && socket.currentRoomId && rooms.has(socket.currentRoomId)) {
            const room = rooms.get(socket.currentRoomId);
            const messageData = { room: data.room, user: socket.username, text: data.text, timestamp: data.timestamp, type: 'message' };
            room.history.push(messageData);
            io.to(data.room).emit('chat message', messageData);
            console.log(`Message in room ${data.room} from ${socket.username}: ${data.text}`);
        }
    });

    // Handle chat actions (/me)
    socket.on('chat action', (data) => {
        if (socket.username && socket.currentRoomId && rooms.has(socket.currentRoomId)) {
            const room = rooms.get(socket.currentRoomId);
            const actionData = { room: data.room, user: socket.username, text: data.text, timestamp: data.timestamp, type: 'action' };
            room.history.push(actionData);
            io.to(data.room).emit('chat action', actionData);
            console.log(`Action in room ${data.room} from ${socket.username}: ${data.text}`);
        }
    });

    // Handle typing indicator
    socket.on('typing', (roomId) => {
        if (socket.username && socket.currentRoomId === roomId && rooms.has(roomId)) {
            socket.to(roomId).emit('user typing', { username: socket.username, room: roomId });
        }
    });

    socket.on('stop typing', (roomId) => {
        if (socket.username && socket.currentRoomId === roomId && rooms.has(roomId)) {
            socket.to(roomId).emit('user stop typing', { username: socket.username, room: roomId });
        }
    });


    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);

        // Remove user from the global users list
        const userIndex = users.findIndex(u => u.id === socket.id);
        if (userIndex !== -1) {
            users.splice(userIndex, 1);
        }

        // Remove user from their current room's user list
        if (socket.currentRoomId && rooms.has(socket.currentRoomId)) {
            const room = rooms.get(socket.currentRoomId);
            room.users.delete(socket.id);
            // Notify others in the room
            io.to(socket.currentRoomId).emit('chat message', { room: socket.currentRoomId, user: 'System', text: `${socket.username} has disconnected.`, timestamp: Date.now() });
            io.to(socket.currentRoomId).emit('update user list', Array.from(room.users).map(id => io.sockets.sockets.get(id).username));

            // If a room becomes empty and it's not the 'general' room, remove it
            if (room.users.size === 0 && room.id !== 'general') {
                rooms.delete(room.id);
                console.log(`Room "${room.name}" (${room.id}) deleted as it is empty.`);
                io.emit('update room list', getRoomList()); // Update room list for all clients
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
