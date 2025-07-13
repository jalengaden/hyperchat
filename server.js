const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
// Initialize Socket.IO with CORS for development flexibility
const io = socketIo(server, {
    cors: {
        origin: "*", // Allow all origins for development. Restrict in production.
        methods: ["GET", "POST"]
    }
});

// Serve static files (your index.html and other client-side assets)
app.use(express.static(__dirname));

// --- Server-Side Data Structures ---
// Store connected users: socket.id -> { username, currentRoomId }
const users = new Map();
// Store rooms: roomId -> { name, pin, history: [], usersInRoom: Set<username> }
const rooms = new Map();
// Store socket.id -> Set<roomId> for easy lookup of rooms a user is in
const userSocketRooms = new Map();

// Initialize a 'general' room
const GENERAL_ROOM_ID = 'general';
if (!rooms.has(GENERAL_ROOM_ID)) {
    rooms.set(GENERAL_ROOM_ID, {
        name: 'General',
        pin: null, // No PIN for the general room
        history: [],
        usersInRoom: new Set() // Store usernames in this set
    });
}

// Helper function to get users in a specific room
function getUsersInRoom(roomId) {
    const room = rooms.get(roomId);
    if (room) {
        // Convert Set to Array for client-side consumption
        return Array.from(room.usersInRoom);
    }
    return [];
}

// Helper function to broadcast user list to a specific room
function broadcastUserList(roomId) {
    const usersInRoom = getUsersInRoom(roomId);
    io.to(roomId).emit('update user list', { room: roomId, users: usersInRoom });
    console.log(`User list updated for room '${roomId}':`, usersInRoom);
}

// Helper function to broadcast room list to all connected sockets
function broadcastRoomList() {
    const availableRooms = Array.from(rooms.entries()).map(([id, room]) => ({
        id: id,
        name: room.name,
        hasPin: room.pin !== null // Indicate if a PIN is required
    }));
    io.emit('update room list', availableRooms); // Emit to all connected clients
    console.log('Room list broadcasted:', availableRooms.map(r => r.name));
}

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Initial setup for a new connection
    users.set(socket.id, { username: null, currentRoomId: null });
    userSocketRooms.set(socket.id, new Set()); // Initialize set for rooms this socket is in

    // Send initial room list to the newly connected client
    broadcastRoomList();

    // --- Event Handlers ---

    // Set initial username
    socket.on('set initial username', (newUsername) => {
        const trimmedUsername = newUsername.trim();
        if (!trimmedUsername) {
            socket.emit('room action feedback', 'Username cannot be empty.');
            return;
        }

        // Check if username is already taken by another active user
        const isUsernameTaken = Array.from(users.values()).some(
            user => user.username === trimmedUsername && user.currentRoomId !== null // Only consider users in a room
        );

        if (isUsernameTaken) {
            socket.emit('room action feedback', `Username '${trimmedUsername}' is already taken. Please choose another.`);
        } else {
            const user = users.get(socket.id);
            user.username = trimmedUsername;
            users.set(socket.id, user); // Update the user map
            socket.emit('username accepted', trimmedUsername);
            console.log(`User ${socket.id} set username to: ${trimmedUsername}`);

            // Automatically join the 'general' room after setting username
            joinRoom(socket, GENERAL_ROOM_ID);
        }
    });

    // Handle username changes (e.g., from /nick command)
    socket.on('change username', (newUsername) => {
        const trimmedNewUsername = newUsername.trim();
        const oldUserData = users.get(socket.id);
        const oldUsername = oldUserData ? oldUserData.username : null;

        if (!trimmedNewUsername) {
            socket.emit('room action feedback', 'New username cannot be empty.');
            return;
        }
        if (trimmedNewUsername === oldUsername) {
            socket.emit('room action feedback', 'That is already your username.');
            return;
        }

        // Check if new username is already taken
        const isUsernameTaken = Array.from(users.values()).some(
            user => user.username === trimmedNewUsername && user.currentRoomId !== null && user.username !== oldUsername
        );

        if (isUsernameTaken) {
            socket.emit('room action feedback', `Username '${trimmedNewUsername}' is already taken. Please choose another.`);
            return;
        }

        if (oldUserData) {
            oldUserData.username = trimmedNewUsername;
            users.set(socket.id, oldUserData); // Update username in global users map
            socket.emit('username updated', trimmedNewUsername);
            console.log(`User ${socket.id} changed username from ${oldUsername} to ${trimmedNewUsername}`);

            // If the user is in a room, update their username in that room's user list
            if (oldUserData.currentRoomId) {
                const room = rooms.get(oldUserData.currentRoomId);
                if (room) {
                    // Remove old username and add new one to the Set
                    if (oldUsername) { // Ensure oldUsername exists before trying to delete
                        room.usersInRoom.delete(oldUsername);
                    }
                    room.usersInRoom.add(trimmedNewUsername);

                    // Add a system message to the room's history
                    room.history.push({
                        type: 'system',
                        text: `<strong>${oldUsername || 'A user'}</strong> is now <strong>${trimmedNewUsername}</strong>.`,
                        timestamp: Date.now()
                    });

                    // Broadcast the updated user list and the system message to the room
                    broadcastUserList(oldUserData.currentRoomId);
                    io.to(oldUserData.currentRoomId).emit('chat message', {
                        room: oldUserData.currentRoomId,
                        user: 'System', // Indicate system message
                        text: `<strong>${oldUsername || 'A user'}</strong> is now <strong>${trimmedNewUsername}</strong>.`,
                        timestamp: Date.now(),
                        type: 'system'
                    });
                }
            }
        }
    });


    // Create a new room
    socket.on('create room', (data) => {
        const { name, pin } = data;
        const trimmedName = name.trim();
        const trimmedPin = pin.trim();

        if (!trimmedName || !trimmedPin) {
            socket.emit('room action feedback', 'Room name and PIN cannot be empty.');
            return;
        }

        // Generate a unique ID for the room (e.g., using a timestamp or UUID)
        const roomId = `room-${Date.now()}`; // Simple unique ID

        if (rooms.has(roomId)) { // Should not happen with Date.now() based ID, but good practice
            socket.emit('room action feedback', 'Failed to create room: Room ID already exists.');
            return;
        }

        rooms.set(roomId, {
            name: trimmedName,
            pin: trimmedPin,
            history: [],
            usersInRoom: new Set()
        });
        console.log(`Room created: ${trimmedName} (${roomId}) with PIN: ${trimmedPin}`);
        socket.emit('room action feedback', `Room '${trimmedName}' created successfully! PIN: ${trimmedPin}`);

        broadcastRoomList(); // Inform all clients about the new room

        // Automatically join the newly created room
        joinRoom(socket, roomId);
    });

    // Join a room by PIN
    socket.on('join room by pin', (pin) => {
        const trimmedPin = pin.trim();
        if (!trimmedPin) {
            socket.emit('room action feedback', 'PIN cannot be empty.');
            return;
        }

        let foundRoomId = null;
        for (const [id, room] of rooms.entries()) {
            if (room.pin === trimmedPin) {
                foundRoomId = id;
                break;
            }
        }

        if (foundRoomId) {
            joinRoom(socket, foundRoomId);
        } else {
            socket.emit('room action feedback', 'No room found with that PIN.');
        }
    });

    // Switch to an existing room (or join if not already in)
    socket.on('switch room', (newRoomId) => {
        joinRoom(socket, newRoomId);
    });

    // Leave the current room (and return to lobby or general)
    socket.on('leave current room', () => {
        const userData = users.get(socket.id);
        if (userData && userData.currentRoomId && userData.currentRoomId !== GENERAL_ROOM_ID) {
            leaveRoom(socket, userData.currentRoomId);
            // After leaving, automatically join the general room
            joinRoom(socket, GENERAL_ROOM_ID);
        } else if (userData && userData.currentRoomId === GENERAL_ROOM_ID) {
            socket.emit('room action feedback', 'You cannot leave the General room. You can only switch to another room.');
        } else {
            socket.emit('room action feedback', 'You are not currently in a room to leave.');
        }
    });


    // Handle incoming chat messages
    socket.on('chat message', (msg) => {
        const userData = users.get(socket.id);
        const currentRoomId = userData ? userData.currentRoomId : null;

        if (currentRoomId && userData.username) {
            const room = rooms.get(currentRoomId);
            if (room) {
                const messageData = {
                    user: userData.username,
                    text: msg.text,
                    timestamp: msg.timestamp,
                    room: currentRoomId,
                    type: 'message'
                };
                room.history.push(messageData);
                io.to(currentRoomId).emit('chat message', messageData); // Emit to all in the room
                console.log(`[Room ${currentRoomId}] ${userData.username}: ${msg.text}`);
            }
        }
    });

    // Handle chat actions (/me command)
    socket.on('chat action', (action) => {
        const userData = users.get(socket.id);
        const currentRoomId = userData ? userData.currentRoomId : null;

        if (currentRoomId && userData.username) {
            const room = rooms.get(currentRoomId);
            if (room) {
                const actionData = {
                    user: userData.username,
                    text: action.text,
                    timestamp: action.timestamp,
                    room: currentRoomId,
                    type: 'action'
                };
                room.history.push(actionData);
                io.to(currentRoomId).emit('chat action', actionData); // Emit to all in the room
                console.log(`[Room ${currentRoomId}] * ${userData.username} ${action.text}`);
            }
        }
    });

    // Typing indicator events
    socket.on('typing', (roomId) => {
        const userData = users.get(socket.id);
        if (userData && userData.username && userData.currentRoomId === roomId) {
            socket.to(roomId).emit('user typing', { username: userData.username, room: roomId });
        }
    });

    socket.on('stop typing', (roomId) => {
        const userData = users.get(socket.id);
        if (userData && userData.username && userData.currentRoomId === roomId) {
            socket.to(roomId).emit('user stop typing', { username: userData.username, room: roomId });
        }
    });

    // Handle user disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const userData = users.get(socket.id);

        if (userData && userData.currentRoomId) {
            leaveRoom(socket, userData.currentRoomId, true); // True to indicate disconnect
        }

        // Clean up user data
        users.delete(socket.id);
        userSocketRooms.delete(socket.id);
        console.log(`User ${socket.id} removed from server data.`);
    });


    // --- Core Room Management Functions (Server-Side) ---

    /**
     * Handles joining a socket to a specific room.
     * @param {Socket} socket The Socket.IO socket object.
     * @param {string} roomId The ID of the room to join.
     * @param {string|null} pin Optional PIN if joining a private room.
     */
    function joinRoom(socket, roomId, pin = null) {
        const userData = users.get(socket.id);
        if (!userData || !userData.username) {
            socket.emit('room action feedback', 'Please set your username first.');
            return;
        }

        const room = rooms.get(roomId);
        if (!room) {
            socket.emit('room action feedback', 'Room does not exist.');
            return;
        }

        // If room has a PIN and it's not the general room, check PIN
        if (room.pin && room.pin !== pin && roomId !== GENERAL_ROOM_ID) {
            socket.emit('room action feedback', 'Incorrect PIN for this room.');
            return;
        }

        // If already in this room, do nothing
        if (userData.currentRoomId === roomId) {
            socket.emit('room action feedback', `You are already in '${room.name}'.`);
            return;
        }

        // Leave previous room if any
        if (userData.currentRoomId) {
            leaveRoom(socket, userData.currentRoomId);
        }

        // Join the new room
        socket.join(roomId);
        userData.currentRoomId = roomId; // Update user's current room
        users.set(socket.id, userData); // Save updated user data
        userSocketRooms.get(socket.id).add(roomId); // Add room to socket's room set

        room.usersInRoom.add(userData.username); // Add user to room's user list
        console.log(`${userData.username} (${socket.id}) joined room: ${room.name} (${roomId})`);

        // Add join message to room history
        const joinMessage = {
            type: 'system',
            text: `<strong>${userData.username}</strong> has joined the room.`,
            timestamp: Date.now(),
            room: roomId
        };
        room.history.push(joinMessage);

        // Send success message and room data to the joining client
        socket.emit('room joined success', {
            roomName: room.name,
            roomId: roomId,
            history: room.history,
            usersInRoom: getUsersInRoom(roomId) // Send current user list for the room
        });

        // Broadcast join message and updated user list to everyone else in the room
        socket.to(roomId).emit('chat message', joinMessage); // Send join message to others
        broadcastUserList(roomId); // Update user list for everyone in the room
    }

    /**
     * Handles a socket leaving a specific room.
     * @param {Socket} socket The Socket.IO socket object.
     * @param {string} roomId The ID of the room to leave.
     * @param {boolean} isDisconnect Flag to indicate if this is part of a full disconnect.
     */
    function leaveRoom(socket, roomId, isDisconnect = false) {
        const userData = users.get(socket.id);
        const room = rooms.get(roomId);

        if (!userData || !room) {
            return; // Nothing to do if user or room doesn't exist
        }

        socket.leave(roomId);
        userSocketRooms.get(socket.id).delete(roomId); // Remove room from socket's room set

        // Remove user from room's user list
        room.usersInRoom.delete(userData.username);
        console.log(`${userData.username} (${socket.id}) left room: ${room.name} (${roomId})`);

        // Add leave message to room history
        const leaveMessage = {
            type: 'system',
            text: `<strong>${userData.username}</strong> has left the room.`,
            timestamp: Date.now(),
            room: roomId
        };
        room.history.push(leaveMessage);

        // Broadcast leave message and updated user list to everyone remaining in the room
        io.to(roomId).emit('chat message', leaveMessage);
        broadcastUserList(roomId);

        // If the room is empty and not the general room, delete it
        if (room.usersInRoom.size === 0 && roomId !== GENERAL_ROOM_ID) {
            rooms.delete(roomId);
            console.log(`Room '${room.name}' (${roomId}) is now empty and deleted.`);
            broadcastRoomList(); // Inform all clients about the deleted room
        }

        // If it's not a full disconnect, clear the user's currentRoomId
        if (!isDisconnect) {
            userData.currentRoomId = null;
            users.set(socket.id, userData);
        }
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
